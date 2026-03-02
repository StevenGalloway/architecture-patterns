use axum::{routing::get, Router, Json};
use serde_json::json;
use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;
use rand::Rng;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::from_default_env()).init();

    let app = Router::new().route("/slow", get(slow));

    let addr = SocketAddr::from(([0,0,0,0], 9202));
    tracing::info!("downstream-slow listening on {}", addr);
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app).await.unwrap();
}

async fn slow() -> (axum::http::StatusCode, Json<serde_json::Value>) {
    let mut rng = rand::thread_rng();

    // 25% errors
    if rng.gen_range(0..100) < 25 {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "service": "downstream-slow", "error": "simulated 500"}))
        );
    }

    // 50% slow responses
    if rng.gen_range(0..100) < 50 {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    }

    (axum::http::StatusCode::OK, Json(json!({"ok": true, "service": "downstream-slow"})))
}
