import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function SettingsDrawer({ title, description, children, footer, error, busy, dirty, onClose, onSubmit }: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
  error?: string;
  busy?: boolean;
  dirty?: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [closeBlocked, setCloseBlocked] = useState(false);

  function dismissIndirectly() {
    if (busy) return;
    if (dirty) { setCloseBlocked(true); return; }
    onClose();
  }

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(<dialog className="settings-drawer" ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true" onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")].filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }} onCancel={(event) => { event.preventDefault(); dismissIndirectly(); }} onClick={(event) => {
    if (busy || event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismissIndirectly();
  }}>
    <form className="settings-drawer-form" onSubmit={onSubmit} aria-busy={busy}>
      <header className="settings-drawer-heading"><div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div><button type="button" className="settings-drawer-close" aria-label="关闭侧边窗" disabled={busy} onClick={onClose}>×</button></header>
      <div className="settings-drawer-body">{children}{closeBlocked && dirty && <p className="settings-drawer-notice" role="status">已输入的内容尚未保存，请保存修改，或使用「取消」或右上角 × 关闭。</p>}{error && <p className="settings-form-error" role="alert">{error}</p>}</div>
      <footer className="settings-drawer-footer">{footer}</footer>
    </form>
  </dialog>, document.body);
}
