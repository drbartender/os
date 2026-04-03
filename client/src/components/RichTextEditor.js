import React, { useEffect, useRef, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';

function MenuBar({ editor, onUploadImage }) {
  const fileRef = useRef(null);

  const handleImageSelect = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = await onUploadImage(file);
    if (url) {
      editor.chain().focus().setImage({ src: url }).run();
    }
    e.target.value = '';
  }, [editor, onUploadImage]);

  if (!editor) return null;

  const btn = (label, action, isActive) => (
    <button
      type="button"
      className={`rte-btn${isActive ? ' rte-btn-active' : ''}`}
      onClick={action}
      title={label}
    >
      {label}
    </button>
  );

  return (
    <div className="rte-toolbar">
      {btn('Bold', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
      {btn('Italic', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
      <span className="rte-divider" />
      {btn('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
      {btn('H3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}
      <span className="rte-divider" />
      {btn('• List', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      {btn('1. List', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {btn('Quote', () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}
      <span className="rte-divider" />
      {btn('Link', () => {
        if (editor.isActive('link')) {
          editor.chain().focus().unsetLink().run();
          return;
        }
        const url = window.prompt('Enter URL:');
        if (url) editor.chain().focus().setLink({ href: url, target: '_blank' }).run();
      }, editor.isActive('link'))}
      <button
        type="button"
        className="rte-btn"
        onClick={() => fileRef.current?.click()}
        title="Insert Image"
      >
        Image
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        style={{ display: 'none' }}
        onChange={handleImageSelect}
      />
      <span className="rte-divider" />
      {btn('Undo', () => editor.chain().focus().undo().run(), false)}
      {btn('Redo', () => editor.chain().focus().redo().run(), false)}
    </div>
  );
}

export default function RichTextEditor({ content, onChange, onUploadImage, placeholder }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: placeholder || 'Start writing or paste your content here...' }),
    ],
    content: content || '',
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML());
    },
  });

  // Sync external content changes (e.g., loading a post for editing)
  const prevContent = useRef(content);
  useEffect(() => {
    if (editor && content !== prevContent.current) {
      const currentHtml = editor.getHTML();
      if (content !== currentHtml) {
        editor.commands.setContent(content || '');
      }
      prevContent.current = content;
    }
  }, [content, editor]);

  return (
    <div className="rte-wrapper">
      <MenuBar editor={editor} onUploadImage={onUploadImage} />
      <EditorContent editor={editor} className="rte-content" />
    </div>
  );
}
