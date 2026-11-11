import ReportBoundary from '../components/ReportBoundary'
import '../styles/globals.css'
import type { AppProps } from 'next/app'
import Layout from '../components/Layout'

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <Layout>
      <ReportBoundary key={Component.name}>
        <Component {...pageProps} />
      </ReportBoundary>
    </Layout>
  )
}

export default MyApp
