import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { AlertTriangle, HelpCircle, X } from "lucide-react";

export type ConfirmOptions = {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除 / 不可恢复）时使用危险色图标与确定按钮。 */
  danger?: boolean;
};

type ConfirmRequest = ConfirmOptions & {
  message: string;
  resolve: (accepted: boolean) => void;
};

type ConfirmContextValue = {
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm(): ConfirmContextValue {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error("useConfirm 必须在 ConfirmProvider 内使用。");
  }
  return context;
}

/**
 * 应用内确认弹窗：替换原生 window.confirm，样式跟随皮肤主题变量。
 * 挂载一次（App 根），各视图用 useConfirm().confirm(...) 调用。
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const queueRef = useRef<ConfirmRequest[]>([]);
  const currentRef = useRef<ConfirmRequest | null>(null);

  const advance = useCallback(() => {
    const next = queueRef.current.shift() || null;
    currentRef.current = next;
    setRequest(next);
  }, []);

  const confirm = useCallback(
    (message: string, options: ConfirmOptions = {}) =>
      new Promise<boolean>((resolve) => {
        queueRef.current.push({ message, ...options, resolve });
        if (!currentRef.current) advance();
      }),
    [advance]
  );

  const settle = useCallback(
    (accepted: boolean) => {
      const current = currentRef.current;
      if (!current) return;
      current.resolve(accepted);
      advance();
    },
    [advance]
  );

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      settle(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request, settle]);

  const title = request?.title || "ArkPet";
  const confirmText = request?.confirmText || "确定";
  const cancelText = request?.cancelText || "取消";
  const danger = request?.danger === true;

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {request && (
        <div className="confirm-backdrop">
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
          >
            <div className="confirm-dialog-body">
              <div
                className={
                  danger
                    ? "confirm-dialog-icon confirm-dialog-icon--danger"
                    : "confirm-dialog-icon"
                }
                aria-hidden="true"
              >
                {danger ? (
                  <AlertTriangle size={17} strokeWidth={2.2} />
                ) : (
                  <HelpCircle size={17} strokeWidth={2.2} />
                )}
              </div>
              <div className="confirm-dialog-text">
                <strong className="confirm-dialog-title" id="confirm-dialog-title">
                  {title}
                </strong>
                <p className="confirm-dialog-message">{request.message}</p>
              </div>
              <button
                className="confirm-dialog-close"
                type="button"
                aria-label="关闭"
                onClick={() => settle(false)}
              >
                <X size={15} strokeWidth={2} />
              </button>
            </div>
            <footer className="confirm-dialog-footer">
              <button
                className="confirm-dialog-cancel"
                type="button"
                onClick={() => settle(false)}
              >
                {cancelText}
              </button>
              <button
                className={
                  danger
                    ? "confirm-dialog-ok confirm-dialog-ok--danger"
                    : "confirm-dialog-ok"
                }
                type="button"
                autoFocus
                onClick={() => settle(true)}
              >
                {confirmText}
              </button>
            </footer>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
