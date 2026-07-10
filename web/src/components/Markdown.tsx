import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render markdown content (tables, code blocks, lists, headers, links). */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, className, children, ...props }: any) {
            const isInline = !className?.includes("language-");
            if (isInline) {
              return <code className="inline-code" {...props}>{children}</code>;
            }
            const lang = className?.replace("language-", "") ?? "";
            return (
              <div className="code-block">
                <div className="code-lang">{lang}</div>
                <pre><code {...props}>{children}</code></pre>
              </div>
            );
          },
          a: ({ node, ...props }: any) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          table: ({ node, ...props }: any) => <div className="table-wrap"><table {...props} /></div>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
