import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type { ForjaApi } from '../../shared/api'

declare global {
  interface Window {
    forja: ForjaApi
  }
}

/** Electron's <webview> tag, used by the browser pane. */
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: string
        useragent?: string
      }
    }
  }
}

export {}
