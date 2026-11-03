import { AppToaster } from '@/components/AppToaster';

import '@/components/theme.css';

export const metadata = {
  title: 'glassjar',
  description: 'Write, run and debug C++, Python and Rust in your browser',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ colorScheme: 'dark' }}>
      <body>
        {children}
        <AppToaster />
      </body>
    </html>
  );
}
