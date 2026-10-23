import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
export type EditorHandle = {
  undo(): void;
  redo(): void;
  insert(text: string): void;
};
export const Editor = forwardRef<
  EditorHandle,
  {
    value: string;
    documentPath: string;
    onChange: (value: string, composing: boolean) => void;
  }
>(({ value, documentPath, onChange }, ref) => {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useImperativeHandle(ref, () => ({
    undo: () => {
      if (view.current) undo(view.current);
    },
    redo: () => {
      if (view.current) redo(view.current);
    },
    insert: (text) => {
      if (view.current) {
        const v = view.current;
        v.dispatch(v.state.replaceSelection(text));
        v.focus();
      }
    },
  }));
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          markdown(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": "Markdown 正文",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              onChangeRef.current(
                update.state.doc.toString(),
                update.view.composing,
              );
          }),
          EditorView.domEventHandlers({
            compositionstart: () => {
              onChangeRef.current(editor.state.doc.toString(), true);
              return false;
            },
            compositionend: () => {
              queueMicrotask(() =>
                onChangeRef.current(editor.state.doc.toString(), false),
              );
              return false;
            },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [documentPath]);
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value)
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
      });
  }, [value]);
  return <div className="editor-shell" ref={host} />;
});
