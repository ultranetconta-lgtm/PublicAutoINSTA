use std::fmt;

#[derive(Debug)]
pub struct MetaError {
    pub message: String,
    pub container_id: Option<String>,
}

impl MetaError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            container_id: None,
        }
    }

    pub fn with_container(mut self, container_id: impl Into<String>) -> Self {
        self.container_id = Some(container_id.into());
        self
    }
}

impl fmt::Display for MetaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MetaError {}
