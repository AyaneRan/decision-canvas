import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Decision Canvas — AI業務改善設計',
  description:
    '現場のファクトを整理・定量化し、人間が問題と課題を決めるための意思決定支援ツール',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
