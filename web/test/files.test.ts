import { expect, test } from 'vitest';
import { isBinary, previewKind } from '../src/lib/files';

test('pictures, PDFs, audio and video are shown by the browser', () => {
  expect(previewKind('photo.JPG')).toBe('image');
  expect(previewKind('report.pdf')).toBe('pdf');
  expect(previewKind('memo.m4a')).toBe('audio');
  expect(previewKind('demo.webm')).toBe('video');
});

test('SVG, Markdown, HTML, code and unknown files are read as text first', () => {
  expect(previewKind('chart.svg')).toBe('svg');
  expect(previewKind('notes.md')).toBe('markdown');
  expect(previewKind('page.html')).toBe('text');
  expect(previewKind('main.py')).toBe('text');
  expect(previewKind('Makefile')).toBe('text');
  expect(previewKind('.env')).toBe('text');
});

test('archives and office documents get no preview', () => {
  expect(previewKind('backup.tar.gz')).toBeNull();
  expect(previewKind('budget.xlsx')).toBeNull();
});

test('a NUL byte near the start marks a file as binary', () => {
  expect(isBinary(new TextEncoder().encode('plain text\n'))).toBe(false);
  expect(isBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
});
