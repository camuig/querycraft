import { describe, expect, it } from "vitest";
import { type MdBlock, parseInline, parseMarkdown } from "../markdown";

describe("parseMarkdown — headings, paragraphs, hr", () => {
  it("parses ATX headings of every level", () => {
    for (let level = 1; level <= 6; level++) {
      const blocks = parseMarkdown(`${"#".repeat(level)} Title`);
      expect(blocks).toEqual([{ type: "heading", level, children: [{ type: "text", text: "Title" }] }]);
    }
  });

  it("does not treat a hash without a following space as a heading", () => {
    const blocks = parseMarkdown("#nospace");
    expect(blocks[0].type).toBe("paragraph");
  });

  it("strips optional closing hashes", () => {
    const blocks = parseMarkdown("## Title ##");
    expect(blocks[0]).toEqual({ type: "heading", level: 2, children: [{ type: "text", text: "Title" }] });
  });

  it("joins a paragraph's soft line breaks with a literal newline", () => {
    const blocks = parseMarkdown("line one\nline two");
    expect(blocks).toEqual([{ type: "paragraph", children: [{ type: "text", text: "line one\nline two" }] }]);
  });

  it("separates paragraphs on a blank line", () => {
    const blocks = parseMarkdown("first\n\nsecond");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[1].type).toBe("paragraph");
  });

  it("parses a thematic break", () => {
    expect(parseMarkdown("---")).toEqual([{ type: "hr" }]);
    expect(parseMarkdown("***")).toEqual([{ type: "hr" }]);
    expect(parseMarkdown("___")).toEqual([{ type: "hr" }]);
  });

  it("does not treat a single dash list marker as an hr", () => {
    const blocks = parseMarkdown("- one item");
    expect(blocks[0].type).toBe("list");
  });
});

describe("parseMarkdown — fenced code", () => {
  it("parses a closed fenced block with a language tag", () => {
    const blocks = parseMarkdown("```sql\nSELECT 1;\n```");
    expect(blocks).toEqual([{ type: "code", lang: "sql", text: "SELECT 1;", closed: true }]);
  });

  it("supports ~~~ fences", () => {
    const blocks = parseMarkdown("~~~\nplain\n~~~");
    expect(blocks).toEqual([{ type: "code", lang: "", text: "plain", closed: true }]);
  });

  it("leaves an unterminated fence open, keeping the streamed-so-far content — important for streaming", () => {
    const blocks = parseMarkdown("```sql\nSELECT 1");
    expect(blocks).toEqual([{ type: "code", lang: "sql", text: "SELECT 1", closed: false }]);
  });

  it("does not close a backtick fence with a shorter run of backticks", () => {
    const blocks = parseMarkdown("````\ncode with ``` inside\n````");
    expect(blocks[0]).toMatchObject({ type: "code", closed: true, text: "code with ``` inside" });
  });
});

describe("parseMarkdown — lists", () => {
  it("parses a simple unordered list", () => {
    const blocks = parseMarkdown("- one\n- two\n- three");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          [{ type: "paragraph", children: [{ type: "text", text: "one" }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "two" }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "three" }] }],
        ],
      },
    ]);
  });

  it("parses an ordered list and keeps its starting number", () => {
    const blocks = parseMarkdown("5. five\n6. six") as [Extract<MdBlock, { type: "list" }>];
    expect(blocks[0].type).toBe("list");
    expect(blocks[0].ordered).toBe(true);
    expect(blocks[0].start).toBe(5);
    expect(blocks[0].items).toHaveLength(2);
  });

  it("supports at least two levels of nested lists", () => {
    const md = ["- top", "  - nested", "    - double nested"].join("\n");
    const blocks = parseMarkdown(md) as [Extract<MdBlock, { type: "list" }>];
    const topList = blocks[0];
    expect(topList.type).toBe("list");
    const nestedList = topList.items[0].find((b) => b.type === "list") as Extract<MdBlock, { type: "list" }>;
    expect(nestedList).toBeDefined();
    const doubleNested = nestedList.items[0].find((b) => b.type === "list");
    expect(doubleNested).toBeDefined();
  });

  it("ends the list when a line dedents past the list", () => {
    const blocks = parseMarkdown("- one\n- two\n\nafter");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list");
    expect(blocks[1]).toEqual({ type: "paragraph", children: [{ type: "text", text: "after" }] });
  });
});

describe("parseMarkdown — tables", () => {
  it("parses a GFM table with alignment", () => {
    const md = ["| Name | Age |", "| :--- | ---: |", "| Ann  | 30   |", "| Bob  | 25   |"].join("\n");
    const blocks = parseMarkdown(md);
    expect(blocks).toEqual([
      {
        type: "table",
        header: [[{ type: "text", text: "Name" }], [{ type: "text", text: "Age" }]],
        align: ["left", "right"],
        rows: [
          [[{ type: "text", text: "Ann" }], [{ type: "text", text: "30" }]],
          [[{ type: "text", text: "Bob" }], [{ type: "text", text: "25" }]],
        ],
      },
    ]);
  });

  it("does not misdetect a setext-style heading as a one-column table", () => {
    const blocks = parseMarkdown("Title\n---");
    expect(blocks.some((b) => b.type === "table")).toBe(false);
  });
});

describe("parseMarkdown — blockquotes", () => {
  it("parses a blockquote's content as nested blocks", () => {
    const blocks = parseMarkdown("> quoted text");
    expect(blocks).toEqual([
      { type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", text: "quoted text" }] }] },
    ]);
  });

  it("supports a nested blockquote", () => {
    const blocks = parseMarkdown("> outer\n> > inner") as [Extract<MdBlock, { type: "blockquote" }>];
    const outer = blocks[0];
    expect(outer.type).toBe("blockquote");
    const innerBlock = outer.children.find((b) => b.type === "blockquote");
    expect(innerBlock).toBeDefined();
  });
});

describe("parseInline", () => {
  it("parses inline code", () => {
    expect(parseInline("use `SELECT 1`")).toEqual([
      { type: "text", text: "use " },
      { type: "code", text: "SELECT 1" },
    ]);
  });

  it("parses strong text with ** and __", () => {
    expect(parseInline("**bold**")).toEqual([{ type: "strong", children: [{ type: "text", text: "bold" }] }]);
    expect(parseInline("__bold__")).toEqual([{ type: "strong", children: [{ type: "text", text: "bold" }] }]);
  });

  it("parses emphasis with * and _", () => {
    expect(parseInline("*em*")).toEqual([{ type: "em", children: [{ type: "text", text: "em" }] }]);
    expect(parseInline("_em_")).toEqual([{ type: "em", children: [{ type: "text", text: "em" }] }]);
  });

  it("does not treat a snake_case identifier as emphasis", () => {
    expect(parseInline("foo_bar_baz")).toEqual([{ type: "text", text: "foo_bar_baz" }]);
  });

  it("parses a link with an http href", () => {
    expect(parseInline("[docs](https://example.com)")).toEqual([
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "docs" }] },
    ]);
  });

  it("keeps a mailto link", () => {
    expect(parseInline("[mail](mailto:a@b.com)")).toEqual([
      { type: "link", href: "mailto:a@b.com", children: [{ type: "text", text: "mail" }] },
    ]);
  });

  it("renders a link with an unsafe scheme as plain text", () => {
    expect(parseInline("[click](javascript:doEvil)")).toEqual([{ type: "text", text: "click" }]);
  });

  it("handles nested inline spans", () => {
    expect(parseInline("**bold with *em* inside**")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", text: "bold with " },
          { type: "em", children: [{ type: "text", text: "em" }] },
          { type: "text", text: " inside" },
        ],
      },
    ]);
  });

  it("leaves an unmatched delimiter as plain text", () => {
    expect(parseInline("a * b")).toEqual([{ type: "text", text: "a * b" }]);
  });
});

describe("robustness", () => {
  it("never throws on arbitrary input", () => {
    const inputs = [
      "",
      "\0\0\0",
      "#".repeat(10000),
      "`".repeat(5000),
      "*".repeat(5000),
      "[".repeat(1000) + "]".repeat(1000),
      `${">".repeat(500)} x`,
      "- ".repeat(2000),
      `${"|".repeat(500)}\n${"-".repeat(500)}`,
      "\r\n\r\n\r\n",
      "😀".repeat(1000),
      Array.from({ length: 20 }, () => `${"  ".repeat(Math.floor(Math.random() * 20))}- item`).join("\n"),
    ];
    for (const input of inputs) {
      expect(() => parseMarkdown(input)).not.toThrow();
      expect(() => parseInline(input)).not.toThrow();
    }
  });

  it("never throws on random fuzz strings", () => {
    const chars = "#*_`[]()|>-. \t\n0123456789abc~";
    for (let i = 0; i < 200; i++) {
      let s = "";
      const len = Math.floor(Math.random() * 200);
      for (let j = 0; j < len; j++) {
        s += chars[Math.floor(Math.random() * chars.length)];
      }
      expect(() => parseMarkdown(s)).not.toThrow();
      expect(() => parseInline(s)).not.toThrow();
    }
  });

  it("never throws on non-string-ish input coerced by callers", () => {
    // @ts-expect-error deliberately passing wrong types to prove the parser is defensive
    expect(() => parseMarkdown(null)).not.toThrow();
    // @ts-expect-error deliberately passing wrong types to prove the parser is defensive
    expect(() => parseInline(undefined)).not.toThrow();
  });
});
