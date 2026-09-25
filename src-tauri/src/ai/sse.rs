//! A minimal Server-Sent-Events parser: reassembles arbitrary byte chunks
//! from an HTTP response body into complete `(event, data)` pairs.
//!
//! It buffers raw bytes (not `String`) so a chunk boundary that falls in the
//! middle of a multi-byte UTF-8 character never breaks decoding — a line is
//! only decoded once its terminating `\n` has arrived, and `\n` never appears
//! as a continuation byte of a valid UTF-8 sequence. Framing follows the SSE
//! spec: `\r\n` and `\n` both end a line, a line starting with `:` is a
//! comment, `data:` lines are folded together with `\n`, and a blank line
//! dispatches the event accumulated so far.

/// Reassembles bytes fed incrementally into `(event, data)` pairs.
#[derive(Default)]
pub(crate) struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Feeds one chunk of bytes and returns every complete `(event, data)`
    /// pair it produced. `data` is the accumulated `data:` lines joined with
    /// `\n`, without a trailing newline. `event` is `None` when the event had
    /// no `event:` line (the OpenAI-compatible protocol never sends one).
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Vec<(Option<String>, String)> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();

        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // the '\n' itself
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();

            if line.is_empty() {
                if self.event.is_some() || !self.data.is_empty() {
                    out.push((self.event.take(), self.data.join("\n")));
                    self.data.clear();
                }
                continue;
            }
            if line.starts_with(':') {
                continue; // comment: not even a heartbeat marker, just ignored
            }
            if let Some(rest) = line.strip_prefix("event:") {
                self.event = Some(rest.trim_start().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                self.data.push(rest.trim_start().to_string());
            }
            // Other fields (id:, retry:) are not used by either protocol.
        }

        out
    }
}

#[cfg(test)]
mod tests {
    use super::SseParser;

    #[test]
    fn parses_a_single_event_in_one_chunk() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"event: message_stop\ndata: {\"a\":1}\n\n");
        assert_eq!(
            events,
            vec![(Some("message_stop".to_string()), "{\"a\":1}".to_string())]
        );
    }

    #[test]
    fn parses_data_only_events_without_an_event_line() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"data: [DONE]\n\n");
        assert_eq!(events, vec![(None, "[DONE]".to_string())]);
    }

    #[test]
    fn folds_multiple_data_lines_with_a_newline() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"data: line one\ndata: line two\n\n");
        assert_eq!(events, vec![(None, "line one\nline two".to_string())]);
    }

    #[test]
    fn ignores_comment_lines() {
        let mut parser = SseParser::new();
        let events = parser.feed(b": keep-alive\ndata: hello\n\n");
        assert_eq!(events, vec![(None, "hello".to_string())]);
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"event: ping\r\ndata: {}\r\n\r\n");
        assert_eq!(events, vec![(Some("ping".to_string()), "{}".to_string())]);
    }

    #[test]
    fn a_blank_line_with_nothing_buffered_dispatches_nothing() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"\n\n\n");
        assert!(events.is_empty());
    }

    #[test]
    fn splits_a_chunk_in_the_middle_of_a_line() {
        let mut parser = SseParser::new();
        assert!(parser.feed(b"event: content_block_delta\ndata: {\"del").is_empty());
        let events = parser.feed(b"ta\":{\"text\":\"hi\"}}\n\n");
        assert_eq!(
            events,
            vec![(
                Some("content_block_delta".to_string()),
                "{\"delta\":{\"text\":\"hi\"}}".to_string()
            )]
        );
    }

    #[test]
    fn splits_a_chunk_in_the_middle_of_a_multi_byte_utf8_character() {
        // "café" — the 'é' is the two-byte sequence 0xC3 0xA9; split right between them.
        let full = "data: caf\u{e9}\n\n".as_bytes().to_vec();
        let (head, tail) = full.split_at(full.len() - 3); // leaves 0xC3 in head, 0xA9.. in tail
        let mut parser = SseParser::new();
        assert!(parser.feed(head).is_empty());
        let events = parser.feed(tail);
        assert_eq!(events, vec![(None, "caf\u{e9}".to_string())]);
    }

    #[test]
    fn splits_a_chunk_exactly_on_a_newline_boundary() {
        let mut parser = SseParser::new();
        assert!(parser.feed(b"data: hello\n").is_empty());
        let events = parser.feed(b"\n");
        assert_eq!(events, vec![(None, "hello".to_string())]);
    }

    #[test]
    fn parses_several_events_delivered_in_one_chunk() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"data: one\n\ndata: two\n\n");
        assert_eq!(events, vec![(None, "one".to_string()), (None, "two".to_string())]);
    }

    #[test]
    fn a_new_event_after_dispatch_does_not_see_the_previous_events_data() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
        assert_eq!(
            events,
            vec![
                (Some("a".to_string()), "1".to_string()),
                (Some("b".to_string()), "2".to_string())
            ]
        );
    }
}
