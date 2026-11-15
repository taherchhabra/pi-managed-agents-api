import { Globe, GlobeLock, ListFilter } from "lucide-react";
import type { NetworkPolicy } from "./types";
import "./network.css";

export interface NetworkDraft { mode: NetworkPolicy["mode"]; domains: string }
export const offlineDraft: NetworkDraft = { mode: "off", domains: "" };
export const networkPolicy = (draft: NetworkDraft): NetworkPolicy => ({ mode: draft.mode,
  allowed_domains: draft.mode === "allowlist" ? [...new Set(draft.domains.split(/[\n,]+/).map(value => value.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))].sort() : [] });
export const networkLabel = (network?: NetworkPolicy) => network?.mode === "internet" ? "Internet" : network?.mode === "allowlist" ? "Domain allowlist" : "Network off";
export function sameNetwork(a: NetworkPolicy | undefined, b: NetworkPolicy) {
  return (a?.mode ?? "off") === b.mode && JSON.stringify([...(a?.allowed_domains ?? [])].sort()) === JSON.stringify(b.allowed_domains);
}
export function NetworkEditor({ value, onChange }: { value: NetworkDraft; onChange: (value: NetworkDraft) => void }) {
  return <div className="network-editor">
    <label className="field">Network access
      <select value={value.mode} onChange={event => onChange({ ...value, mode: event.target.value as NetworkDraft["mode"] })}>
        <option value="off">Off — offline desktop</option>
        <option value="internet">Internet — public websites</option>
        <option value="allowlist">Allowlist — selected domains</option>
      </select>
    </label>
    {value.mode === "allowlist" && <label className="field">Allowed domains
      <textarea rows={3} required value={value.domains} onChange={event => onChange({ ...value, domains: event.target.value })} placeholder={"example.com\n*.example.com"} spellCheck={false} />
      <small>One hostname per line. *.example.com allows subdomains; add example.com separately for the main site. Include any domains needed for redirects or page assets.</small>
    </label>}
    <p className="field-hint">{value.mode === "off" ? "No internet connection. Apps and local files still work." : "HTTP and HTTPS on ports 80 and 443. Host, private networks, and cloud metadata are blocked. Apps must use the configured proxy."} The policy stays with each session.</p>
  </div>;
}
export function NetworkSummary({ network }: { network?: NetworkPolicy }) {
  const mode = network?.mode ?? "off";
  const Icon = mode === "off" ? GlobeLock : mode === "allowlist" ? ListFilter : Globe;
  return <div className={`network-summary ${mode}`}><Icon size={17} /><div><strong>{networkLabel(network)}</strong>
    <p>{mode === "off" ? "This desktop has no internet connection." : mode === "allowlist" ? network!.allowed_domains.join(" · ") : "Public HTTP/HTTPS · Private networks blocked"}</p>
  </div></div>;
}
