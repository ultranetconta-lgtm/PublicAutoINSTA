use api_publicacao_backend::app::{
    AppConfig, AppState, build_router, run_scheduler, run_token_maintenance,
};
use std::{env, net::SocketAddr, path::PathBuf};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let root = env::var_os("APP_ROOT")
        .map(PathBuf::from)
        .or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(PathBuf::from)
        })
        .ok_or_else(|| anyhow::anyhow!("could not locate project root"))?;
    let config = AppConfig::load(&root);
    let state = AppState::new(config, &root)?;
    state.initialize().await?;
    let host = cli_value("--host")
        .unwrap_or_else(|| env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into()));
    let port = cli_value("--port")
        .or_else(|| env::var("PORT").ok())
        .unwrap_or_else(|| "3000".into())
        .parse::<u16>()?;
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "Planner Rust backend listening");

    let scheduler = tokio::spawn(run_scheduler(state.clone()));
    let token_maintenance = tokio::spawn(run_token_maintenance(state.clone()));
    let result = axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await;
    scheduler.abort();
    token_maintenance.abort();
    result?;
    Ok(())
}

fn cli_value(option: &str) -> Option<String> {
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == option {
            return args.next();
        }
    }
    None
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
