//! Schema metadata shared by every backend (the explorer tree contract).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub kind: TableKind,
    /// Storage engine (MySQL, ClickHouse) when the catalog reports one.
    pub engine: Option<String>,
    /// Approximate row count from the catalog, when available.
    pub rows: Option<u64>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// Base type, e.g. "int", "varchar".
    pub data_type: String,
    /// Full type, e.g. "varchar(255)", "int unsigned", "Nullable(String)".
    pub column_type: String,
    pub nullable: bool,
    /// "PRI" | "UNI" | "MUL" | "" — the MySQL `COLUMN_KEY` vocabulary; other
    /// engines map their constraints onto it (the frontend relies on "PRI").
    pub key: String,
    pub default_value: Option<String>,
    /// Engine-specific extras, e.g. "auto_increment", "generated".
    pub extra: String,
    pub comment: String,
    /// Ordinal position, starting at 1.
    pub ordinal: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
    pub index_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_database: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}
