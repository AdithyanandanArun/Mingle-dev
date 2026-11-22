import { isValidElement, memo, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, WrapText } from 'lucide-react';
import { copyText } from '../lib/clipboard';

function CodeBlock({ children, language }: { children: ReactNode; language?: string }) {
  const [wrapped, setWrapped] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const text = typeof children === 'string' ? children : '';
  const currentText = useRef(text);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    currentText.current = text;
    setCopied(false);
    setCopyError('');
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, [text]);
  const copy = async () => {
    if (copying || !text) return;
    setCopying(true); setCopyError(''); setCopied(false);
    if (timer.current) clearTimeout(timer.current);
    try {
      await copyText(text.replace(/\n$/, ''));
      if (!alive.current || currentText.current !== text) return;
      setCopied(true);
      timer.current = setTimeout(() => { setCopied(false); timer.current = null; }, 1800);
    } catch {
      if (alive.current && currentText.current === text) setCopyError('Could not copy. Select the code and copy it manually.');
    } finally { if (alive.current) setCopying(false); }
  };
  return (
    <div className={`codeblock${wrapped ? ' is-wrapped' : ''}`}>
      <div className="codeblock__toolbar">
        <span>{language || 'Code'}</span>
        <button type="button" className="codeblock__wrap" aria-label="Wrap code lines" aria-pressed={wrapped} onClick={() => setWrapped(!wrapped)}><WrapText size={12} aria-hidden="true" /> Wrap</button>
      <button type="button" className="codeblock__copy" aria-label="Copy code" aria-busy={copying || undefined} disabled={copying || !text} onClick={() => void copy()}>
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />} {copied ? 'Copied' : copying ? 'Copying…' : 'Copy'}
      </button>
      </div>
      {copied ? <span className="sr-only" role="status">Code copied to clipboard</span> : null}
      {copyError ? <p className="codeblock__error" role="alert">{copyError}</p> : null}
      <pre tabIndex={0} aria-label={language ? `${language} code` : 'Code block'}><code>{children}</code></pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <>{children}</>,
          img: ({ src, alt, title }) => src
            ? <img className="md__image" src={src} alt={alt ?? ''} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
            : <>{alt}</>,
          pre: ({ children }) => {
            if (!isValidElement<ComponentProps<'code'>>(children)) return <pre>{children}</pre>;
            const language = children.props.className?.match(/\blanguage-([^\s]+)/)?.[1];
            return <CodeBlock language={language}>{children.props.children}</CodeBlock>;
          },
          code: ({ children }) => <code className="md__inline">{children}</code>,
          table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function MarkdownTable({ children }: { children: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const region = scroll.current;
    if (!region || !table.current) return;
    const measure = () => setOverflow(region.scrollWidth > region.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    observer.observe(table.current);
    measure();
    return () => observer.disconnect();
  }, []);
  return <div ref={scroll} className="md__table" tabIndex={overflow ? 0 : undefined} role={overflow ? 'region' : undefined} aria-label={overflow ? 'Scrollable table' : undefined}>
    <table ref={table}>{children}</table>
  </div>;
}
