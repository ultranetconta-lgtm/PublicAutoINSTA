use crate::{app::AppState, error::MetaError};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::America::Sao_Paulo;
use futures_util::{StreamExt, stream};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const CACHE_TTL: Duration = Duration::from_secs(20);
const META_CONCURRENCY: usize = 5;
const MONTHS_PT: [&str; 12] = [
    "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

pub async fn build_analytics(
    state: &AppState,
    requested_period: &str,
    force_refresh: bool,
) -> Result<Value, MetaError> {
    let period = match requested_period.trim().to_ascii_lowercase().as_str() {
        "today" => "today",
        "7d" => "7d",
        "30d" => "30d",
        _ => "30d",
    };
    let service = state
        .service
        .as_ref()
        .ok_or_else(|| MetaError::new("Instagram account insights are not configured"))?;
    let today = Utc::now().with_timezone(&Sao_Paulo).date_naive();
    let days_count = match period {
        "today" => 1,
        "7d" => 7,
        _ => 30,
    };
    let first_day = today - ChronoDuration::days(days_count - 1);
    let day_after_today = today + ChronoDuration::days(1);
    let first_timestamp = local_midnight(first_day).timestamp();
    let end_timestamp = local_midnight(day_after_today).timestamp();

    let (profile, media_items) = get_snapshot(state, force_refresh).await;
    let username = profile
        .get("username")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&state.config.instagram_username);
    let followers_count = profile
        .get("followers_count")
        .cloned()
        .unwrap_or(Value::Null);
    let media_count = profile.get("media_count").cloned().unwrap_or(Value::Null);
    let profile_picture_url = profile
        .get("profile_picture_url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("assets/avatar.jpg");

    let totals = service
        .get_account_insights(&["views", "reach"], first_timestamp, end_timestamp)
        .await?;
    let views = *totals.get("views").unwrap_or(&0);
    let reach = *totals.get("reach").unwrap_or(&0);
    let last_24_hours_until = Utc::now().timestamp();
    let last_24_hours_since = last_24_hours_until - 24 * 60 * 60;
    let last_24_hours_metrics = service
        .get_account_insights(
            &["views", "reach"],
            last_24_hours_since,
            last_24_hours_until,
        )
        .await
        .ok();

    let days = (0..days_count)
        .map(|index| first_day + ChronoDuration::days(index))
        .collect::<Vec<_>>();
    let daily_results = stream::iter(days.iter().copied())
        .map(|day| async move {
            let since = local_midnight(day).timestamp();
            let until = local_midnight(day + ChronoDuration::days(1)).timestamp();
            let result = service.get_account_insights(&["views"], since, until).await;
            result.map(|values| (day, *values.get("views").unwrap_or(&0)))
        })
        .buffer_unordered(META_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut daily_views = HashMap::new();
    for result in daily_results {
        let (day, count) = result?;
        daily_views.insert(day, count);
    }

    let mut reels = Vec::new();
    let mut reels_count_24h = 0_usize;
    for item in &media_items {
        let product_type = item
            .get("media_product_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        let media_type = item
            .get("media_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        if product_type != "REELS" && media_type != "VIDEO" {
            continue;
        }
        let timestamp = item.get("timestamp").and_then(Value::as_str).unwrap_or("");
        let Some(published_at) = parse_timestamp(timestamp) else {
            continue;
        };
        let published_epoch = published_at.timestamp();
        if last_24_hours_since <= published_epoch && published_epoch <= last_24_hours_until {
            reels_count_24h += 1;
        }
        let published_day = published_at.with_timezone(&Sao_Paulo).date_naive();
        if published_day < first_day || published_day > today {
            continue;
        }

        let mut reel = Map::new();
        reel.insert(
            "id".into(),
            Value::String(
                item.get("id")
                    .map(value_to_string)
                    .unwrap_or_else(|| "None".into()),
            ),
        );
        let caption = item
            .get("caption")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        reel.insert(
            "caption".into(),
            Value::String(if caption.is_empty() {
                "Reel sem legenda".into()
            } else {
                caption.into()
            }),
        );
        let thumbnail = item
            .get("thumbnail_url")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| item.get("media_url").and_then(Value::as_str))
            .unwrap_or("assets/avatar.jpg");
        reel.insert("thumbnail_url".into(), Value::String(thumbnail.to_string()));
        reel.insert(
            "permalink".into(),
            item.get("permalink")
                .cloned()
                .unwrap_or_else(|| Value::String(format!("https://www.instagram.com/{username}"))),
        );
        reel.insert("timestamp".into(), Value::String(timestamp.to_string()));
        for field in ["like_count", "comments_count"] {
            if let Some(value) = item.get(field).and_then(numeric_as_integer) {
                reel.insert(field.into(), json!(value));
            }
        }
        reels.push((published_day, Value::Object(reel)));
    }

    let view_results = stream::iter(reels.into_iter().enumerate())
        .map(|(index, (day, mut reel))| async move {
            let media_id = reel
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Ok(views) = service.get_media_views(&media_id).await
                && let Some(object) = reel.as_object_mut()
            {
                object.insert("views".into(), json!(views));
            }
            (index, day, reel)
        })
        .buffer_unordered(META_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut view_results = view_results;
    view_results.sort_by_key(|(index, _, _)| *index);
    let mut reels_by_day: HashMap<NaiveDate, Vec<Value>> = HashMap::new();
    let mut flat_reels = Vec::with_capacity(view_results.len());
    for (_, day, reel) in view_results {
        reels_by_day.entry(day).or_default().push(reel.clone());
        flat_reels.push(reel);
    }

    let points = days
        .iter()
        .map(|day| {
            let label = if *day == today {
                "Hoje*".to_string()
            } else {
                format!("{:02} {}", day.day(), MONTHS_PT[(day.month() - 1) as usize])
            };
            json!({
                "date": day.to_string(),
                "label": label,
                "views": daily_views.get(day).copied().unwrap_or(0),
                "partial": *day == today,
                "reels": reels_by_day.get(day).cloned().unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    let max_view = points
        .iter()
        .filter_map(|point| point.get("views").and_then(Value::as_i64))
        .max()
        .unwrap_or(0);
    let ceiling = 10_000_i64.max(((max_view + 9_999) / 10_000) * 10_000);
    let step = ceiling / 5;
    let steps = (0..=5).rev().map(|index| step * index).collect::<Vec<_>>();
    let view_labels = steps
        .iter()
        .map(|value| {
            if *value >= 1_000 {
                format!("{}k", value / 1_000)
            } else {
                "0".into()
            }
        })
        .collect::<Vec<_>>();
    let metrics = json!({
        "views": views,
        "views_formatted": format_metric(views),
        "reach": reach,
        "reach_formatted": format_metric(reach),
        "followers_count": followers_count,
        "reels_count": flat_reels.len(),
        "views_24h": last_24_hours_metrics.as_ref().and_then(|values| values.get("views")).copied(),
        "reach_24h": last_24_hours_metrics.as_ref().and_then(|values| values.get("reach")).copied(),
        "reels_count_24h": reels_count_24h,
    });

    Ok(json!({
        "ok": true,
        "period": period,
        "updated_at": Utc::now().to_rfc3339(),
        "timezone": "America/Sao_Paulo",
        "freshness_notice": "A Meta pode levar até 48 horas para consolidar alguns Insights.",
        "range": { "start": first_day.to_string(), "end": today.to_string(), "days": days_count, "today_partial": true },
        "account": { "username": username, "media_count": media_count, "profile_picture_url": profile_picture_url },
        "metrics": metrics,
        "chart": { "lateral_axis": { "min": 0, "max": ceiling, "steps": steps, "labels": view_labels }, "points": points },
        "reels": flat_reels,
    }))
}

async fn get_snapshot(state: &AppState, force_refresh: bool) -> (Value, Vec<Value>) {
    let mut cached = state.analytics_snapshot.lock().await;
    if !force_refresh
        && let Some((at, profile, media)) = cached.as_ref()
        && at.elapsed() < CACHE_TTL
    {
        return (profile.clone(), media.clone());
    }
    let (profile, media) = if let Some(service) = state.service.as_ref() {
        let profile = service.get_profile().await.unwrap_or_else(|_| json!({}));
        let media = service.get_recent_media(100).await.unwrap_or_default();
        (profile, media)
    } else {
        (json!({}), Vec::new())
    };
    *cached = Some((Instant::now(), profile.clone(), media.clone()));
    (profile, media)
}

fn local_midnight(day: NaiveDate) -> DateTime<chrono_tz::Tz> {
    Sao_Paulo
        .from_local_datetime(&day.and_time(NaiveTime::MIN))
        .single()
        .unwrap_or_else(|| Sao_Paulo.from_utc_datetime(&day.and_time(NaiveTime::MIN)))
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z")
                .ok()
                .map(|date| date.with_timezone(&Utc))
        })
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .map(|date| Utc.from_utc_datetime(&date))
        })
}

fn numeric_as_integer(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number as i64))
}

fn value_to_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn format_metric(value: i64) -> String {
    if value >= 1_000 {
        format!("{:.1}", value as f64 / 1_000.0).replace('.', ",") + " mil"
    } else {
        value.to_string()
    }
}
