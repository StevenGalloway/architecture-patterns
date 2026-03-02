use axum::{routing::get, Router, Json};
use serde_json::json;
use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::from_default_env()).init();

    let app = Router::new().route("/fast", get(fast));

    let addr = SocketAddr::from(([0,0,0,0], 9201));
    tracing::info!("downstream-fast listening on {}", addr);
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app).await.unwrap();
}

async fn fast() -> Json<serde_json::Value> {
    Json(json!({"ok": true, "service": "downstream-fast"}))
}
