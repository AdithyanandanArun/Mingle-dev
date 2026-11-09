import { memo, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../lib/clipboard';

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  const text = typeof children === 'string' ? children : '';
  const copy = async () => {
    if (copying) return;
    setCopying(true); setCopyError(''); setCopied(false);
    if (timer.current) clearTimeout(timer.current);
    try {
      await copyText(text.replace(/\n$/, ''));
      if (!alive.current) return;
      setCopied(true);
      timer.current = setTimeout(() => { setCopied(false); timer.current = null; }, 1800);
    } catch {
      if (alive.current) setCopyError('Could not copy. Select the code and copy it manually.');
    } finally { if (alive.current) setCopying(false); }
  };
  return (
    <div className="codeblock">
      <button type="button" className="codeblock__copy" aria-label="Copy code" aria-busy={copying || undefined} disabled={copying} onClick={() => void copy()}>
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />} {copied ? 'Copied' : copying ? 'Copying…' : 'Copy'}
      </button>
      {copied ? <span className="sr-only" role="status">Code copied to clipboard</span> : null}
      {copyError ? <p className="codeblock__error" role="alert">{copyError}</p> : null}
      <pre><code>{children}</code></pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...rest }: ComponentProps<'code'>) => {
            const isBlock = /language-/.test(className ?? '') || (typeof children === 'string' && children.includes('\n'));
            return isBlock ? <CodeBlock>{children}</CodeBlock> : <code className="md__inline" {...rest}>{children}</code>;
          },
          table: ({ children }) => <div className="md__table"><table>{children}</table></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
