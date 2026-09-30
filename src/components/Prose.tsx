// Scenario text is written in YAML block scalars, which keep the author's
// line breaks. Render it like Markdown paragraphs instead: blank lines split
// paragraphs, single newlines are just spaces, so text reflows on any screen.
export default function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      {text
        .trim()
        .split(/\n\s*\n/)
        .map((para, i) => (
          <p key={i}>{para.replace(/\s*\n\s*/g, ' ')}</p>
        ))}
    </div>
  )
}
