import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const EXTERNAL = /^(https?:|mailto:)/i;

/**
 * Raw HTML in the file is not rendered (react-markdown's default). Links open
 * in the browser instead of navigating the app; images only show their alt
 * text, since the webview may not load remote or relative files.
 */
const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && EXTERNAL.test(href)) void openUrl(href);
      }}
    >
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="md-image">{alt ? `[${alt}]` : "[image]"}</span>,
};

export default function MarkdownView({ text }: { text: string }) {
  return (
    <article className="markdown p-3">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </article>
  );
}
