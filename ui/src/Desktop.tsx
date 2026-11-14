import { useEffect, useState } from 'react';
import { Camera, Expand, Eye, Monitor, Pause, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, date } from './client';
import { ErrorBox, Modal } from './components';
import type { Event, Session } from './types';
import './desktop.css';

interface DesktopState { state: 'not_started' | 'starting' | 'running' | 'paused' | 'stopped' }
export function ScreenshotEvidence({ event }: { event: Event }) {
  return <div className="screenshot-evidence">{event.data.images?.map((image: { id: string; url: string; width: number; height: number }) =>
    <a key={image.id} href={image.url} target="_blank" rel="noreferrer" title="Open full screenshot">
      <img src={image.url} alt={`Desktop screenshot from event ${event.seq}`} loading="lazy" />
      <span><Camera size={13} />{image.width} × {image.height} · Saved with event {event.seq}</span>
    </a>)}</div>;
}

export function DesktopPanel({ session, events }: { session: Session; events: Event[] }) {
  const [state, setState] = useState<DesktopState['state']>('not_started');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState('');
  const [revision, setRevision] = useState(0);
  const [live, setLive] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const screenshots = events.filter(event => event.data.images?.length);
  useEffect(() => {
    if (session.status === 'archived') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let url = '';
    const refresh = async () => {
      if (document.hidden) { timer = setTimeout(refresh, 3000); return; }
      try {
        const status = await api<DesktopState>(`/v1/sessions/${session.id}/desktop`);
        if (controller.signal.aborted) return;
        setState(status.state);
        if (['running', 'paused'].includes(status.state)) {
          const response = await fetch(`/v1/sessions/${session.id}/desktop/frame`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
          if (response.status === 401) { window.dispatchEvent(new CustomEvent('pi:unauthorized')); return; }
          if (response.ok) {
            const blob = await response.blob();
            if (controller.signal.aborted) return;
            const next = URL.createObjectURL(blob);
            if (url) URL.revokeObjectURL(url);
            url = next; setImage(next); setUpdated(new Date().toISOString());
          } else if (response.status !== 409) throw new Error('Desktop preview is unavailable. The agent’s saved screenshots are below.');
        }
        setError('');
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
      if (!controller.signal.aborted && live) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [session.id, session.status, revision, live]);
  const label = session.status === 'archived' ? 'Archived' : state === 'running' ? 'Live desktop' : state === 'paused' ? 'Desktop paused' : state === 'starting' ? 'Starting desktop' : state === 'stopped' ? 'Desktop stopped' : 'Ready for its first task';
  return <div className="desktop-panel">
    <div className="desktop-title"><span className="desktop-symbol"><Monitor size={22} /></span><div><h3>Linux desktop</h3><p>Ubuntu · Xfce · HCU</p></div><span className={`desktop-state ${state}`}><i />{label}</span></div>
    <div className="desktop-stage">
      {image && session.status !== 'archived' ? <img src={image} alt="Current session desktop, read-only preview" /> : <div className="desktop-placeholder"><Monitor size={46} strokeWidth={1.3} /><h3>{session.status === 'archived' ? 'This desktop has been archived' : state === 'starting' ? 'Preparing your desktop…' : 'A computer for your agent'}</h3><p>{session.status === 'archived' ? 'Its saved screenshots and results are still available below.' : 'Send a task to start the VM. Watch the agent use apps, inspect controls, and work on screen.'}</p></div>}
      <div className="desktop-view-label"><Eye size={13} />Read-only preview</div>
    </div>
    <div className="desktop-toolbar"><span>{state === 'paused' ? <Pause size={14} /> : <span className="tiny-dot" />}{updated ? `Last checked ${new Date(updated).toLocaleTimeString()}` : 'Waiting for a frame'}</span><div>
      <button className="icon-button" title={live ? 'Pause preview updates' : 'Resume preview updates'} aria-label={live ? 'Pause preview updates' : 'Resume preview updates'} onClick={() => setLive(!live)}><Eye size={16} /></button>
      <button className="icon-button" title="Refresh desktop preview" aria-label="Refresh desktop preview" onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} /></button>
      <button className="icon-button" title="Expand desktop" aria-label="Expand desktop" disabled={!image || session.status === 'archived'} onClick={() => setExpanded(true)}><Expand size={16} /></button>
    </div></div>
    <ErrorBox error={error} retry={() => setRevision(value => value + 1)} />
    <p className="desktop-note"><ShieldCheck size={15} />{state === 'paused' ? 'Apps stay open. Sending another task resumes this desktop.' : 'Private VM · no internet · preview updates every 3 seconds'}{!live && ' · Preview updates paused'}</p>
    <div className="desktop-history-heading"><h3><Camera size={16} />Agent observations</h3><span className="count">{screenshots.length}</span></div>
    <p className="field-hint">The screenshots the model actually received, saved with each tool result.</p>
    {!screenshots.length ? <div className="desktop-empty-history">GUI screenshots and visual AX observations will appear here.</div> : <div className="desktop-history">{[...screenshots].reverse().map(event => <article key={event.id}><div><strong>Observation {screenshots.indexOf(event) + 1}</strong><span>{date(event.created_at)}</span></div><ScreenshotEvidence event={event} /></article>)}</div>}
    {expanded && <Modal title="Linux desktop · HCU" subtitle={`${label} · Read-only preview. Send a task in the Playground to use this computer.`} close={() => setExpanded(false)}><img className="desktop-expanded" src={image} alt="Expanded read-only view of the session desktop" /></Modal>}
  </div>;
}
