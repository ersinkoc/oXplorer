import { Plus, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type Connection, commands, type RemoteKind } from "@/bindings";
import { useT } from "@/i18n";
import { describeError } from "@/lib/ipc";
import type { Preferences } from "@/stores/app-store";

type UsePref = <K extends keyof Preferences>(key: K) => [Preferences[K], (v: Preferences[K]) => void];

const input =
  "h-7 w-full rounded-md border border-border bg-bg px-2 text-[13px] outline-none focus:ring-2 focus:ring-accent/40";

function blank(): Connection {
  return {
    id: `conn-${crypto.randomUUID()}`,
    name: "",
    kind: "sftp",
    host: "",
    user: "",
    root: "",
    bucket: "",
    region: "",
  };
}

/** Servers shown in the sidebar: SFTP, WebDAV and S3. Secrets go to the Keychain. */
export function ConnectionsSection({ usePref }: { usePref: UsePref }) {
  const { t } = useT();
  const [connections, setConnections] = usePref("connections");
  const [editing, setEditing] = useState<Connection | null>(null);

  const save = (c: Connection) => {
    const exists = connections.some((x) => x.id === c.id);
    setConnections(exists ? connections.map((x) => (x.id === c.id ? c : x)) : [...connections, c]);
    setEditing(null);
  };
  const remove = (c: Connection) => {
    setConnections(connections.filter((x) => x.id !== c.id));
    void commands.remoteSaveSecret(c.id, "");
    setEditing(null);
  };

  return (
    <section>
      <h1 className="m-0 mb-1 text-[17px] font-semibold">{t("Connections")}</h1>
      <p className="m-0 mb-3 text-[12px] text-fg-muted">
        {t("Servers appear in the sidebar and open like folders. Passwords are kept in your Keychain.")}
      </p>
      {editing ? (
        <ConnectionForm
          key={editing.id}
          initial={editing}
          onSave={save}
          onCancel={() => setEditing(null)}
          onDelete={remove}
        />
      ) : (
        <>
          <div className="rounded-md border border-border">
            {connections.length === 0 && (
              <p className="m-0 p-3 text-[12px] text-fg-muted">{t("No connections yet.")}</p>
            )}
            {connections.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setEditing(c)}
                className="flex h-9 w-full items-center gap-2 border-b border-border px-3 text-left last:border-0 hover:bg-hover"
              >
                <Server className="size-4 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">{c.name || c.host}</span>
                <span className="text-[11px] text-fg-muted uppercase">{c.kind}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setEditing(blank())}
            className="mt-2 flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg px-3 hover:bg-hover"
          >
            <Plus className="size-3.5" />
            {t("Add Connection")}
          </button>
        </>
      )}
    </section>
  );
}

function ConnectionForm({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Connection;
  onSave: (c: Connection) => void;
  onCancel: () => void;
  onDelete: (c: Connection) => void;
}) {
  const { t } = useT();
  const [c, setC] = useState(initial);
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void commands.remoteHasSecret(initial.id).then(setHasSecret);
  }, [initial.id]);

  const set = <K extends keyof Connection>(k: K, v: Connection[K]) => setC((x) => ({ ...x, [k]: v }));
  const field = (
    k: "name" | "host" | "user" | "root" | "bucket" | "region",
    label: string,
    placeholder = "",
  ) => (
    <label className="grid grid-cols-[130px_1fr] items-center gap-2">
      <span className="text-right text-fg-muted">{label}</span>
      <input
        value={c[k]}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => set(k, e.target.value)}
        className={input}
      />
    </label>
  );

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    const r = await commands.remoteTest(c, secret || null);
    setTest(
      r.status === "ok"
        ? { ok: true, message: t("Connected.") }
        : { ok: false, message: describeError(r.error) },
    );
    setBusy(false);
  };

  const submit = async () => {
    if (secret) await commands.remoteSaveSecret(c.id, secret);
    onSave({ ...c, name: c.name.trim() || c.host });
  };

  const kinds: [RemoteKind, string][] = [
    ["sftp", "SFTP"],
    ["webdav", "WebDAV"],
    ["s3", "S3"],
  ];
  const valid = c.kind === "s3" ? !!c.bucket.trim() : !!c.host.trim();

  return (
    <form
      className="flex flex-col gap-2 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
      }}
    >
      <label className="grid grid-cols-[130px_1fr] items-center gap-2">
        <span className="text-right text-fg-muted">{t("Type")}</span>
        <select value={c.kind} onChange={(e) => set("kind", e.target.value as RemoteKind)} className={input}>
          {kinds.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {field("name", t("Name"), t("My server"))}
      {c.kind === "sftp" && (
        <>
          {field("host", t("Host"), "example.com:22")}
          {field("user", t("User"))}
          <p className="m-0 ml-[138px] text-[11px] text-fg-muted">
            {t("Signs in with your SSH keys, agent and ~/.ssh/config, like the ssh command.")}
          </p>
        </>
      )}
      {c.kind === "webdav" && (
        <>
          {field("host", t("Server URL"), "https://dav.example.com/remote.php/dav/files/me")}
          {field("user", t("User"))}
        </>
      )}
      {c.kind === "s3" && (
        <>
          {field("bucket", t("Bucket"))}
          {field("region", t("Region"), "eu-central-1")}
          {field("host", t("Endpoint"), t("Empty for AWS"))}
          {field("user", t("Access key ID"))}
        </>
      )}
      {c.kind !== "sftp" && (
        <label className="grid grid-cols-[130px_1fr] items-center gap-2">
          <span className="text-right text-fg-muted">
            {c.kind === "s3" ? t("Secret access key") : t("Password")}
          </span>
          <input
            type="password"
            value={secret}
            placeholder={hasSecret ? t("Saved in Keychain — type to replace") : ""}
            onChange={(e) => setSecret(e.target.value)}
            className={input}
          />
        </label>
      )}
      {field("root", t("Folder"), "/")}
      {test && (
        <p
          role="status"
          className={`m-0 ml-[138px] text-[12px] ${test.ok ? "text-green-600" : "text-red-500"}`}
        >
          {test.message}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        {initial.name && (
          <button
            type="button"
            onClick={() => onDelete(initial)}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-red-500 hover:bg-hover"
          >
            <Trash2 className="size-3.5" />
            {t("Remove")}
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => void runTest()}
          className="h-7 rounded-md border border-border px-3 hover:bg-hover disabled:opacity-40"
        >
          {t("Test Connection")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-md border border-border px-3 hover:bg-hover"
        >
          {t("Cancel")}
        </button>
        <button
          type="submit"
          disabled={!valid}
          className="h-7 rounded-md bg-accent px-3 text-white disabled:opacity-40"
        >
          {t("Save")}
        </button>
      </div>
    </form>
  );
}
