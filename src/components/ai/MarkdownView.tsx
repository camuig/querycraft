import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo } from "react";
import { type MdBlock, type MdInline, parseMarkdown } from "../../lib/ai/markdown";
import { toast } from "../../store/toastStore";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Languages the "Insert into console" button is offered for — the two query languages QueryCraft speaks. */
const INSERTABLE_LANGS = new Set(["sql", "redis"]);

async function copyText(text: string) {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  }
  toast.success("Copied to clipboard");
}

async function openLink(href: string) {
  if (isTauri) {
    await openUrl(href).catch(() => undefined);
  } else {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

function renderInline(nodes: MdInline[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        // biome-ignore lint/suspicious/noArrayIndexKey: inline spans are a positional, re-parsed AST
        return node.text ? <span key={i}>{node.text}</span> : null;
      case "code":
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline spans are a positional, re-parsed AST
          <code key={i} className="mono">
            {node.text}
          </code>
        );
      case "strong":
        // biome-ignore lint/suspicious/noArrayIndexKey: inline spans are a positional, re-parsed AST
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        // biome-ignore lint/suspicious/noArrayIndexKey: inline spans are a positional, re-parsed AST
        return <em key={i}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: inline spans are a positional, re-parsed AST
            key={i}
            href={node.href}
            onClick={(e) => {
              e.preventDefault();
              void openLink(node.href);
            }}
          >
            {renderInline(node.children)}
          </a>
        );
      default:
        return null;
    }
  });
}

interface CodeBlockProps {
  lang: string;
  text: string;
  onInsertCode?: (code: string, lang: string) => void;
}

function CodeBlock({ lang, text, onInsertCode }: CodeBlockProps) {
  const normalizedLang = lang.trim().toLowerCase();
  const insertable = INSERTABLE_LANGS.has(normalizedLang) && !!onInsertCode;
  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{lang || "text"}</span>
        <div className="spacer" />
        <button type="button" className="md-code-action" onClick={() => void copyText(text)}>
          Copy
        </button>
        {insertable && (
          <button type="button" className="md-code-action" onClick={() => onInsertCode?.(text, normalizedLang)}>
            Insert
          </button>
        )}
      </div>
      <pre className="mono text-select">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Blocks({ blocks, onInsertCode }: { blocks: MdBlock[]; onInsertCode?: (code: string, lang: string) => void }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading": {
            const Tag = `h${Math.min(block.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a positional, re-parsed AST
            return <Tag key={i}>{renderInline(block.children)}</Tag>;
          }
          case "paragraph":
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a positional, re-parsed AST
            return <p key={i}>{renderInline(block.children)}</p>;
          case "code":
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a positional, re-parsed AST
            return <CodeBlock key={i} lang={block.lang} text={block.text} onInsertCode={onInsertCode} />;
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a positional, re-parsed AST
              <ListTag key={i} start={block.ordered ? block.start : undefined}>
                {block.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: list items are a positional, re-parsed AST
                  <li key={j}>
                    <Blocks blocks={item} onInsertCode={onInsertCode} />
                  </li>
                ))}
              </ListTag>
            );
          }
          case "table":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a positional, re-parsed AST
              <div key={i} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, c) => {
                        const align = block.align[c];
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: table columns are positional
                          <th key={c} style={align ? { textAlign: align } : undefined}>
                            {renderInline(cell)}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional
                      <tr key={r}>
                        {row.map((cell, c) => {
                          const align = block.align[c];
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: table columns are positional
                            <td key={c} style={align ? { textAlign: align } : undefined}>
                              {renderInline(cell)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "blockquote":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a positional, re-parsed AST
              <blockquote key={i}>
                <Blocks blocks={block.children} onInsertCode={onInsertCode} />
              </blockquote>
            );
          case "hr":
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a positional, re-parsed AST
            return <hr key={i} />;
          default:
            return null;
        }
      })}
    </>
  );
}

export interface MarkdownViewProps {
  text: string;
  /** Wires the code block's "Insert" button; omit to hide it (e.g. no active connection to insert into). */
  onInsertCode?: (code: string, lang: string) => void;
}

/** Renders a chat message's Markdown as React elements — never `dangerouslySetInnerHTML`. */
export function MarkdownView({ text, onInsertCode }: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      <Blocks blocks={blocks} onInsertCode={onInsertCode} />
    </div>
  );
}
