//! Engine-independent helpers for turning scalar values into `CellValue` JSON.
//!
//! Integers beyond the JS safe range and non-finite floats become strings so
//! the frontend never loses precision; binary data becomes a `0x…` hex string.

use serde_json::Value;

/// The largest integer that JS can represent exactly (2^53 - 1).
pub const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;
/// Limit on the hex string size for binary values (in hex characters).
pub const MAX_HEX_CHARS: usize = 64 * 1024;

pub fn int_to_json(n: i64) -> Value {
    if n.unsigned_abs() <= MAX_SAFE_INT {
        Value::Number(n.into())
    } else {
        Value::String(n.to_string())
    }
}

pub fn uint_to_json(n: u64) -> Value {
    if n <= MAX_SAFE_INT {
        Value::Number(n.into())
    } else {
        Value::String(n.to_string())
    }
}

pub fn float_to_json(n: f64) -> Value {
    if n.is_finite() {
        serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(n.to_string()))
    } else {
        Value::String(n.to_string())
    }
}

/// Parses the text representation of an integer and decides whether it fits
/// within the JS-safe-integer range; if not, returns the original text as a string.
pub fn text_to_number(text: &str, unsigned: bool) -> Value {
    if unsigned {
        if let Ok(n) = text.parse::<u64>() {
            return uint_to_json(n);
        }
    } else if let Ok(n) = text.parse::<i64>() {
        return int_to_json(n);
    }
    Value::String(text.to_string())
}

pub fn text_to_float(text: &str) -> Value {
    match text.parse::<f64>() {
        Ok(n) => float_to_json(n),
        Err(_) => Value::String(text.to_string()),
    }
}

/// A hex string like "0xAABBCC", truncated to `MAX_HEX_CHARS` hex characters
/// (appends "…" when truncated).
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    let truncated = bytes.len().saturating_mul(2) > MAX_HEX_CHARS;
    let take = if truncated { MAX_HEX_CHARS / 2 } else { bytes.len() };
    let mut out = String::with_capacity(2 + take * 2 + if truncated { 1 } else { 0 });
    out.push_str("0x");
    for b in &bytes[..take] {
        out.push_str(&format!("{b:02X}"));
    }
    if truncated {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_to_number_small_signed() {
        assert_eq!(text_to_number("-42", false), serde_json::json!(-42));
    }

    #[test]
    fn text_to_number_small_unsigned() {
        assert_eq!(text_to_number("42", true), serde_json::json!(42));
    }

    #[test]
    fn text_to_number_beyond_safe_int_becomes_string() {
        let big = (MAX_SAFE_INT + 1).to_string();
        assert_eq!(text_to_number(&big, true), serde_json::json!(big));
    }

    #[test]
    fn text_to_number_negative_beyond_safe_int_becomes_string() {
        let big = -(MAX_SAFE_INT as i64) - 1;
        let text = big.to_string();
        assert_eq!(text_to_number(&text, false), serde_json::json!(text));
    }

    #[test]
    fn text_to_number_unparsable_falls_back_to_string() {
        assert_eq!(text_to_number("not-a-number", false), serde_json::json!("not-a-number"));
    }

    #[test]
    fn text_to_float_basic() {
        assert_eq!(text_to_float("3.5"), serde_json::json!(3.5));
    }

    #[test]
    fn text_to_float_unparsable_falls_back_to_string() {
        assert_eq!(text_to_float("abc"), serde_json::json!("abc"));
    }

    #[test]
    fn bytes_to_hex_basic() {
        assert_eq!(bytes_to_hex(&[0xDE, 0xAD, 0xBE, 0xEF]), "0xDEADBEEF");
    }

    #[test]
    fn bytes_to_hex_truncates_large_input() {
        let data = vec![0xABu8; MAX_HEX_CHARS / 2 + 10];
        let hex = bytes_to_hex(&data);
        assert!(hex.ends_with('…'));
        // "0x" + MAX_HEX_CHARS hex chars + "…"
        assert_eq!(hex.chars().count(), 2 + MAX_HEX_CHARS + 1);
    }

    #[test]
    fn int_to_json_within_safe_range() {
        assert_eq!(int_to_json(123), serde_json::json!(123));
    }

    #[test]
    fn float_to_json_nan_becomes_string() {
        assert_eq!(float_to_json(f64::NAN), serde_json::json!("NaN"));
    }

    #[test]
    fn float_to_json_infinity_becomes_string() {
        assert_eq!(float_to_json(f64::INFINITY), serde_json::json!("inf"));
    }
}
