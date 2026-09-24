use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AccountStore {
    path: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct StoredAccount {
    pub id: String,
    pub username: String,
    access_token: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct PublicAccount {
    pub id: String,
    pub username: String,
}

impl StoredAccount {
    pub fn new(id: String, username: String, access_token: String) -> Self {
        Self {
            id,
            username,
            access_token,
        }
    }

    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    pub fn public(&self) -> PublicAccount {
        PublicAccount {
            id: self.id.clone(),
            username: self.username.clone(),
        }
    }
}

impl AccountStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Arc::new(path.into()),
            lock: Arc::new(Mutex::new(())),
        }
    }

    async fn read_accounts(&self) -> Result<Vec<StoredAccount>> {
        let contents = match tokio::fs::read_to_string(self.path.as_path()).await {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error).context("could not read account store"),
        };
        serde_json::from_str(&contents).context("could not parse account store")
    }

    async fn write_accounts(&self, accounts: &[StoredAccount]) -> Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| anyhow!("account store has no parent directory"))?;
        tokio::fs::create_dir_all(parent)
            .await
            .context("could not create account directory")?;
        let temp_path = self
            .path
            .with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4().simple()));
        let mut contents =
            serde_json::to_vec_pretty(accounts).context("could not encode accounts")?;
        contents.push(b'\n');

        let write_result = write_private_file(&temp_path, &contents);
        if let Err(error) = write_result {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(error).context("could not write private account store");
        }
        if let Err(error) = tokio::fs::rename(&temp_path, self.path.as_path()).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(error).context("could not replace account store");
        }
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<StoredAccount>> {
        let _guard = self.lock.lock().await;
        self.read_accounts().await
    }

    pub async fn add(&self, account: StoredAccount) -> Result<()> {
        let _guard = self.lock.lock().await;
        let mut accounts = self.read_accounts().await?;
        if accounts.iter().any(|existing| existing.id == account.id) {
            return Err(anyhow!("account_already_connected"));
        }
        accounts.push(account);
        self.write_accounts(&accounts).await
    }
}

fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}
