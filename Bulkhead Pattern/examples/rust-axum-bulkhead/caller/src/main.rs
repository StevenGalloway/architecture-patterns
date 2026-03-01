use axum::{routing::get, Router, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
struct AppState {
    fast_url: String,
    slow_url: String,
    fast_sem: Arc<Semaphore>,
    slow_sem: Arc<Semaphore>,
    client: reqwest::Client,
    timeout: Duration,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::from_default_env()).init();

    let fast_url = std::env::var("FAST_URL").unwrap_or_else(|_| "http://localhost:9201/fast".into());
    let slow_url = std::env::var("SLOW_URL").unwrap_or_else(|_| "http://localhost:9202/slow".into());

    let fast_permits: usize = std::env::var("FAST_PERMITS").ok().and_then(|v| v.parse().ok()).unwrap_or(50);
    let slow_permits: usize = std::env::var("SLOW_PERMITS").ok().and_then(|v| v.parse().ok()).unwrap_or(5);

    let timeout_ms: u64 = std::env::var("DOWNSTREAM_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(700);

    let state = AppState {
        fast_url,
        slow_url,
        fast_sem: Arc::new(Semaphore::new(fast_permits)),
        slow_sem: Arc::new(Semaphore::new(slow_permits)),
        client: reqwest::Client::builder().build().unwrap(),
        timeout: Duration::from_millis(timeout_ms),
    };

    let app = Router::new()
        .route("/call/fast", get(call_fast))
        .route("/call/slow", get(call_slow))
        .route("/status", get(status))
        .with_state(state);

    let addr = SocketAddr::from(([0,0,0,0], 9200));
    tracing::info!("caller listening on {}", addr);
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app).await.unwrap();
}

async fn call_fast(axum::extract::State(state): axum::extract::State<AppState>) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    bulkhead_call(&state, &state.fast_sem, &state.fast_url, "fast").await
}

async fn call_slow(axum::extract::State(state): axum::extract::State<AppState>) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    bulkhead_call(&state, &state.slow_sem, &state.slow_url, "slow").await
}

async fn bulkhead_call(
    state: &AppState,
    sem: &Semaphore,
    url: &str,
    label: &str,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    // Try acquire without waiting: fail-fast when saturated
    let permit = match sem.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            return (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "ok": false,
                    "mode": "bulkhead_reject",
                    "dependency": label,
                    "hint": "capacity preserved; retry later or use fallback"
                }))
            );
        }
    };

    // Ensure permit is released when dropped
    let _permit = permit;

    let fut = state.client.get(url).send();
    let resp = match tokio::time::timeout(state.timeout, fut).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            return (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(json!({
                    "ok": false,
                    "dependency": label,
                    "error": format!("request error: {e}")
                }))
            );
        }
        Err(_) => {
            return (
                axum::http::StatusCode::GATEWAY_TIMEOUT,
                Json(json!({
                    "ok": false,
                    "dependency": label,
                    "error": "timeout"
                }))
            );
        }
    };

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_else(|_| "<unreadable>".into());

    if !status.is_success() {
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({
                "ok": false,
                "dependency": label,
                "downstream_status": status.as_u16(),
                "downstream_body": body_text,
                "mode": "fallback_possible"
            }))
        );
    }

    (
        axum::http::StatusCode::OK,
        Json(json!({
            "ok": true,
            "dependency": label,
            "downstream_body": body_text
        }))
    )
}

async fn status(axum::extract::State(state): axum::extract::State<AppState>) -> Json<serde_json::Value> {
    let fast_available = state.fast_sem.available_permits();
    let slow_available = state.slow_sem.available_permits();
    Json(json!({
        "fast": { "available_permits": fast_available },
        "slow": { "available_permits": slow_available },
        "fast_url": state.fast_url,
        "slow_url": state.slow_url
    }))
}
