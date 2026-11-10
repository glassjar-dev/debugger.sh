//! Conversion between byte offsets and LSP positions (0-based line, UTF-16 column).

use ra_ap_ide::{TextRange, TextSize};
use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Pos {
    pub line: u32,
    pub character: u32,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Range {
    pub start: Pos,
    pub end: Pos,
}

/// Line starts for a text, plus the text itself for UTF-16 conversions.
pub struct TextPos {
    text: String,
    line_starts: Vec<u32>,
}

impl TextPos {
    pub fn new(text: &str) -> TextPos {
        let mut line_starts = vec![0];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i as u32 + 1);
            }
        }
        TextPos { text: text.to_owned(), line_starts }
    }

    fn line_bounds(&self, line: usize) -> (usize, usize) {
        let start = self.line_starts[line] as usize;
        let end = self
            .line_starts
            .get(line + 1)
            .map(|&s| s as usize - 1)
            .unwrap_or(self.text.len());
        (start, end)
    }

    /// LSP position -> byte offset, clamped to the line end / text end.
    pub fn offset(&self, line: u32, character: u32) -> TextSize {
        let line = line as usize;
        if line >= self.line_starts.len() {
            return TextSize::of(self.text.as_str());
        }
        let (start, end) = self.line_bounds(line);
        let mut units = 0u32;
        let mut offset = start;
        for ch in self.text[start..end].chars() {
            if units >= character {
                break;
            }
            units += ch.len_utf16() as u32;
            offset += ch.len_utf8();
        }
        TextSize::from(offset as u32)
    }

    /// Byte offset -> LSP position.
    pub fn pos(&self, offset: TextSize) -> Pos {
        let offset = (u32::from(offset) as usize).min(self.text.len());
        let line = match self.line_starts.binary_search(&(offset as u32)) {
            Ok(l) => l,
            Err(l) => l - 1,
        };
        let start = self.line_starts[line] as usize;
        let mut end = offset;
        while !self.text.is_char_boundary(end) {
            end -= 1;
        }
        let character = self.text[start..end].encode_utf16().count() as u32;
        Pos { line: line as u32, character }
    }

    pub fn range(&self, range: TextRange) -> Range {
        Range { start: self.pos(range.start()), end: self.pos(range.end()) }
    }
}
