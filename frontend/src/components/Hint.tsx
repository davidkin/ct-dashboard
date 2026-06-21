/**
 * Inline-подсказка. Наведи мышь на "?" — увидишь объяснение.
 * Использование:
 *   <Hint text="Сколько раз кликнули на ссылку">Clicks</Hint>
 *   <th>Clicks <Hint text="..." /></th>
 */
export function Hint({
  text,
  children,
  size = 14,
}: {
  text: string;
  children?: React.ReactNode;
  size?: number;
}) {
  return (
    <span className="hint-wrap">
      {children}
      <span
        className="hint-icon"
        data-hint={text}
        style={{ width: size, height: size, fontSize: size - 4 }}
        aria-label={text}
      >
        ?
      </span>
    </span>
  );
}
