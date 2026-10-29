import { useState } from "react";
import { create } from "zustand";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";

interface Request {
  title: string;
  message: string;
  /** Asks twice (a new password), so a typo doesn't lock the archive. */
  confirm: boolean;
  resolve: (password: string | null) => void;
}

const usePrompt = create<{ request: Request | null }>()(() => ({ request: null }));

/** Asks for a password; null when cancelled. The text is never stored. */
export function askPassword(opts: {
  title: string;
  message: string;
  confirm?: boolean;
}): Promise<string | null> {
  usePrompt.getState().request?.resolve(null);
  return new Promise((resolve) =>
    usePrompt.setState({ request: { ...opts, confirm: opts.confirm ?? false, resolve } }),
  );
}

export function PasswordPrompt() {
  const { t } = useT();
  const request = usePrompt((s) => s.request);
  const finish = (value: string | null) => {
    request?.resolve(value);
    usePrompt.setState({ request: null });
  };
  return (
    <Dialog
      open={!!request}
      onClose={() => finish(null)}
      label={request?.title ?? t("Password")}
      className="w-[360px]"
    >
      {request && <Body key={request.title + request.message} request={request} onDone={finish} />}
    </Dialog>
  );
}

function Body({ request, onDone }: { request: Request; onDone: (value: string | null) => void }) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = request.confirm && again.length > 0 && again !== password;
  const ready = password.length > 0 && (!request.confirm || again === password);
  return (
    <form
      className="flex flex-col gap-3 p-5 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onDone(password);
      }}
    >
      <p className="m-0 font-semibold">{request.title}</p>
      <p className="m-0 text-[12px] text-fg-muted">{request.message}</p>
      <input
        type="password"
        aria-label={t("Password")}
        placeholder={t("Password")}
        // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this input
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="h-7 rounded-md border border-border bg-bg px-2 outline-none focus:ring-2 focus:ring-accent/40"
      />
      {request.confirm && (
        <input
          type="password"
          aria-label={t("Verify")}
          placeholder={t("Verify")}
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          aria-invalid={mismatch}
          className={`h-7 rounded-md border bg-bg px-2 outline-none focus:ring-2 focus:ring-accent/40 ${mismatch ? "border-red-500" : "border-border"}`}
        />
      )}
      {mismatch && <p className="m-0 text-[12px] text-red-500">{t("The passwords don’t match.")}</p>}
      <div className="flex justify-end gap-2">
        <DialogButton onClick={() => onDone(null)}>{t("Cancel")}</DialogButton>
        <DialogButton primary disabled={!ready} onClick={() => onDone(password)}>
          {t("OK")}
        </DialogButton>
      </div>
    </form>
  );
}
