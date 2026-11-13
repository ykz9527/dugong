import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { SITE_URL } from "@/const";

export function SEO() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const title = t("meta.title");
  const description = t("meta.description");
  const image = `${SITE_URL}/images/screenshot-desktop.png`;

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "dugong",
    operatingSystem: "macOS, Linux, Windows",
    applicationCategory: "DeveloperApplication",
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    description,
  };

  return (
    <Helmet>
      <html lang={isZh ? "zh-CN" : "en"} />
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={`${SITE_URL}/`} />
      <link rel="alternate" hrefLang="en" href={`${SITE_URL}/?lng=en`} />
      <link rel="alternate" hrefLang="zh" href={`${SITE_URL}/?lng=zh`} />
      <link rel="alternate" hrefLang="x-default" href={`${SITE_URL}/`} />

      <meta property="og:type" content="website" />
      <meta property="og:url" content={`${SITE_URL}/`} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={image} />
      <meta property="og:locale" content={isZh ? "zh_CN" : "en_US"} />
      <meta property="og:site_name" content="dugong" />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />

      <script type="application/ld+json">{JSON.stringify(structuredData)}</script>
    </Helmet>
  );
}
