import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Bot, Check, ChevronDown, ChevronRight, Clock3, Code2, FileText, MessageSquare, Search, Terminal, X } from "lucide-react";
import Markdown from "react-markdown";
import { CopyButton } from "./components";
import { docPages } from "./docs/content";
import exampleCode from "../../examples/run.mjs?raw";
import "./docs/docs.css";

const href = (page: string, section?: string) =>
  "#/docs/" + page + (section ? "?section=" + section : "");

function CodeSample({ value, language }: { value: string; language: string }) {
  const labels: Record<string, string> = {
    text: "Try this prompt", sh: "Terminal", js: "quickstart.mjs",
    json: "JSON", dotenv: "Environment variables", javascript: "JavaScript",
  };
  return (
    <div className={"docs-code" + (language === "text" ? " docs-prompt" : "")}>
      <div className="docs-code-heading">
        <span><Terminal size={14} />{labels[language] ?? language}</span>
        <CopyButton value={value} label={"Copy " + (labels[language] ?? language)} />
      </div>
      <pre tabIndex={0}><code>{value}</code></pre>
    </div>
  );
}

function GuideNavigation({ current, navigate }: { current: string; navigate?: () => void }) {
  return (
    <nav aria-label="Documentation guides" className="docs-guide-nav">
      {[...new Set(docPages.map(page => page.group))].map(group => (
        <div key={group}>
          <h2>{group}</h2>
          {docPages.filter(page => page.group === group).map(page => (
            <a key={page.id} href={href(page.id)} onClick={navigate}
              className={page.id === current ? "active" : undefined}
              aria-current={page.id === current ? "page" : undefined}>
              {page.id === "get-started" ? <BookOpen size={16} />
                : page.id === "api-quickstart" ? <Code2 size={16} /> : <span className="docs-nav-dot" />}
              {page.title}
              {page.id === current && <ChevronRight size={13} />}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function Documentation({ route }: { route: string }) {
  const [path, search = ""] = route.split("?");
  const pageId = path?.split("/")[2] || "get-started";
  const page = docPages.find(item => item.id === pageId);
  const [query, setQuery] = useState("");
  const mobileNav = useRef<HTMLDetailsElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchText = query.trim().toLowerCase();
  const matches = searchText ? docPages.flatMap(item => {
    const section = item.sections.find(section =>
      (section.title + " " + section.body).toLowerCase().includes(searchText));
    const titleMatch = (item.title + " " + item.description).toLowerCase().includes(searchText);
    return titleMatch || section ? [{
      page: item, section: titleMatch ? undefined : section,
    }] : [];
  }) : [];
  useEffect(() => {
    setQuery("");
    if (mobileNav.current) mobileNav.current.open = false;
    document.title = (page?.title ?? "Guide not found") + " · Pi Agents Docs";
    const section = new URLSearchParams(search).get("section");
    if (section && document.getElementById(section)) {
      document.getElementById(section)?.scrollIntoView({ block: "start" });
    } else {
      window.scrollTo({ top: 0 });
      heading.current?.focus({ preventScroll: true });
    }
  }, [route, page, search]);
  useEffect(() => () => { document.title = "Pi Agents · Console"; }, []);
  const index = docPages.findIndex(item => item.id === pageId);
  const previous = docPages[index - 1];
  const next = docPages[index + 1];
  const closeMobileNav = () => { if (mobileNav.current) mobileNav.current.open = false; };
  return (
    <div className="docs-root">
      <a className="docs-skip" href={href(pageId, "docs-article")}>Skip to content</a>
      <header className="docs-header">
        <a href={href("get-started")} className="brand">
          <span className="brand-mark">π</span>
          <span>pi <strong>agents</strong></span>
          <span className="docs-brand-label">Docs</span>
        </a>
        <div className="docs-search-wrap">
          <label className="docs-search">
            <Search size={17} />
            <input type="search" aria-label="Search documentation" placeholder="Search documentation…"
              value={query} onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === "Escape") setQuery(""); }} />
            {query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}
          </label>
          {searchText && (
            <div className="docs-search-results" role="region" aria-label="Search results">
              <p className="docs-search-caption" role="status">{matches.length ? matches.length + " guides found" : "No guides found"}</p>
              {matches.map(match => (
                <a key={match.page.id} href={href(match.page.id, match.section?.id)} onClick={() => setQuery("")}>
                  <BookOpen size={16} /><span><strong>{match.page.title}</strong><small>{match.section?.title ?? match.page.description}</small></span><ArrowRight size={14} />
                </a>
              ))}
              {!matches.length && <p className="docs-no-results">Try “model”, “sandbox”, “API token”, or “logs”.</p>}
            </div>
          )}
        </div>
        <a href="#/agents" className="button docs-console-link">Open console <ArrowRight size={15} /></a>
      </header>
      <details className="docs-mobile-navigation" ref={mobileNav}>
        <summary><BookOpen size={16} />{page?.title ?? "Guides"}<ChevronDown size={16} /></summary>
        <GuideNavigation current={pageId} navigate={closeMobileNav} />
      </details>
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <div className="docs-sidebar-label">DOCUMENTATION</div>
          <GuideNavigation current={pageId} />
          <div className="docs-sidebar-note"><span className="tiny-dot" />Built on the Pi coding agent SDK</div>
        </aside>
        <article className="docs-article" id="docs-article">
          {page ? <>
            <div className="docs-breadcrumb"><BookOpen size={14} /><span>Documentation</span><ChevronRight size={12} /><span>{page.group}</span></div>
            <div className="docs-page-meta"><span>{page.id === "get-started" ? "YOUR FIRST AGENT" : page.group.toUpperCase()}</span><span><Clock3 size={13} />{page.minutes} read</span></div>
            <h1 tabIndex={-1} ref={heading}>{page.title}</h1>
            <p className="docs-lead">{page.description}</p>
            {page.id === "connect-your-app" && <div className="docs-endpoint">
              <span>This instance’s API origin</span>
              <div><code>{window.location.origin}</code><CopyButton value={window.location.origin} label="Copy API origin" /></div>
              <small>Append /v1 to call the API. Keep your workspace token in your app backend.</small>
            </div>}
            {page.id === "get-started" && <>
              <div className="docs-intro-actions">
                <a className="button primary" href="#/agents/new?starter=0">Create your first agent <ArrowRight size={15} /></a>
                <a className="docs-inline-link" href={href("api-quickstart")}>Prefer the API? <Code2 size={15} /></a>
              </div>
              <div className="docs-flow" aria-label="An agent works in a session, executes a run, and produces a result">
                <span><Bot size={20} /><strong>Agent</strong><small>Define the purpose</small></span>
                <ChevronRight size={15} />
                <span><MessageSquare size={20} /><strong>Session</strong><small>Keep the context</small></span>
                <ChevronRight size={15} />
                <span><Terminal size={20} /><strong>Run</strong><small>Do the work</small></span>
                <ChevronRight size={15} />
                <span><FileText size={20} /><strong>Result</strong><small>Inspect the output</small></span>
              </div>
            </>}
            {page.sections.map(section => (
              <section className="docs-section" id={section.id} key={section.id}>
                <h2><a href={href(page.id, section.id)}>{section.title}<span aria-hidden="true">#</span></a></h2>
                <Markdown components={{
                  pre: ({ children }) => <>{children}</>,
                  code: ({ className, children }) => {
                    const language = className?.replace("language-", "");
                    return language
                      ? <CodeSample value={String(children).replace(/\n$/, "")} language={language} />
                      : <code>{children}</code>;
                  },
                }}>{section.body}</Markdown>
                {page.id === "api-quickstart" && section.id === "client" &&
                  <CodeSample value={exampleCode.trimEnd()} language="js" />}
              </section>
            ))}
            {page.id === "get-started" && <div className="docs-complete"><Check size={18} /><div><strong>You have the whole loop.</strong><p>An agent, a persistent session, a completed run, and files you can use.</p></div></div>}
            <nav className="docs-pagination" aria-label="Next and previous guides">
              {previous ? <a href={href(previous.id)}><ArrowLeft size={17} /><span><small>Previous</small><strong>{previous.title}</strong></span></a> : <span />}
              {next && <a href={href(next.id)}><span><small>Next guide</small><strong>{next.title}</strong></span><ArrowRight size={17} /></a>}
            </nav>
            <footer className="docs-footer">Pi Managed Agents <span>Guides for the current MVP</span></footer>
          </> : <div className="docs-not-found"><h1 ref={heading} tabIndex={-1}>Guide not found</h1><p>This documentation page does not exist.</p><a className="button primary" href={href("get-started")}>Go to Get started <ArrowRight size={15} /></a></div>}
        </article>
        {page && <aside className="docs-toc"><span>ON THIS PAGE</span><nav aria-label="On this page">{page.sections.map(section =>
          <a href={href(page.id, section.id)} key={section.id}>{section.title.replace(/^\d+\.\s/, "")}</a>
        )}</nav><a className="docs-toc-help" href={href("runs-and-logs", "troubleshoot")}>Need a hand?<br /><strong>Troubleshoot a run <ArrowRight size={13} /></strong></a></aside>}
      </div>
    </div>
  );
}
