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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct PublicAccount {
    pub id: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_picture_url: Option<String>,
}

impl StoredAccount {
    pub fn new(id: String, username: String, access_token: String) -> Self {
        Self {
            id,
            username,
            access_token,
            expires_at: None,
        }
    }

    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    pub fn expires_at(&self) -> Option<i64> {
        self.expires_at
    }

    pub fn public(&self) -> PublicAccount {
        PublicAccount {
            id: self.id.clone(),
            username: self.username.clone(),
            profile_picture_url: None,
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

    pub async fn upsert(&self, account: StoredAccount) -> Result<()> {
        let _guard = self.lock.lock().await;
        let mut accounts = self.read_accounts().await?;
        if let Some(existing) = accounts
            .iter_mut()
            .find(|existing| existing.id == account.id)
        {
            *existing = account;
        } else {
            accounts.push(account);
        }
        self.write_accounts(&accounts).await
    }

    pub async fn insert_if_absent(&self, account: StoredAccount) -> Result<()> {
        let _guard = self.lock.lock().await;
        let mut accounts = self.read_accounts().await?;
        if accounts.iter().any(|existing| existing.id == account.id) {
            return Ok(());
        }
        accounts.push(account);
        self.write_accounts(&accounts).await
    }

    pub async fn replace_token_if_current(
        &self,
        account_id: &str,
        current_token: &str,
        new_token: &str,
        expires_at: i64,
    ) -> Result<bool> {
        if new_token.is_empty() || expires_at <= 0 {
            return Err(anyhow!("invalid refreshed token"));
        }
        let _guard = self.lock.lock().await;
        let mut accounts = self.read_accounts().await?;
        let Some(account) = accounts
            .iter_mut()
            .find(|account| account.id == account_id && account.access_token == current_token)
        else {
            return Ok(false);
        };
        account.access_token = new_token.to_string();
        account.expires_at = Some(expires_at);
        self.write_accounts(&accounts).await?;
        Ok(true)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_accounts_without_expiry_remain_readable() {
        let account: StoredAccount = serde_json::from_str(
            r#"{"id":"ig-123","username":"account","access_token":"legacy-token"}"#,
        )
        .unwrap();
        assert_eq!(account.access_token(), "legacy-token");
        assert_eq!(account.expires_at(), None);
    }

    #[tokio::test]
    async fn refresh_does_not_overwrite_a_newly_connected_token() {
        let directory = tempfile::tempdir().unwrap();
        let store = AccountStore::new(directory.path().join("accounts.json"));
        store
            .add(StoredAccount::new(
                "ig-123".into(),
                "account".into(),
                "old".into(),
            ))
            .await
            .unwrap();
        store
            .upsert(StoredAccount::new(
                "ig-123".into(),
                "account".into(),
                "new".into(),
            ))
            .await
            .unwrap();

        assert!(
            !store
                .replace_token_if_current("ig-123", "old", "refreshed", 1_900_000_000)
                .await
                .unwrap()
        );
        assert_eq!(store.list().await.unwrap()[0].access_token(), "new");
    }

    #[tokio::test]
    async fn configured_token_seed_preserves_an_existing_renewed_account() {
        let directory = tempfile::tempdir().unwrap();
        let store = AccountStore::new(directory.path().join("accounts.json"));
        store
            .add(StoredAccount::new(
                "ig-123".into(),
                "account".into(),
                "renewed".into(),
            ))
            .await
            .unwrap();

        store
            .insert_if_absent(StoredAccount::new(
                "ig-123".into(),
                "account".into(),
                "configured-old".into(),
            ))
            .await
            .unwrap();
        assert_eq!(store.list().await.unwrap()[0].access_token(), "renewed");
    }

    #[tokio::test]
    async fn upsert_replaces_credentials_for_an_existing_instagram_account() {
        let directory = tempfile::tempdir().unwrap();
        let store = AccountStore::new(directory.path().join("accounts.json"));
        store
            .add(StoredAccount::new(
                "ig-123".into(),
                "alessantorooficial".into(),
                "old-token".into(),
            ))
            .await
            .unwrap();

        store
            .upsert(StoredAccount::new(
                "ig-123".into(),
                "alessantorooficial".into(),
                "new-token".into(),
            ))
            .await
            .unwrap();

        let accounts = store.list().await.unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].username, "alessantorooficial");
        assert_eq!(accounts[0].access_token(), "new-token");
    }
}
