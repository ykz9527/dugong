import Layout from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";

export default function NotFound() {
  const { t } = useTranslation();

  return (
    <Layout>
      <div className="container py-24 text-center space-y-4">
        <p className="text-5xl font-bold">404</p>
        <h1 className="text-xl font-semibold">{t("notFound.title")}</h1>
        <p className="text-muted-foreground">{t("notFound.body")}</p>
        <Button asChild>
          <Link href="/">{t("notFound.back")}</Link>
        </Button>
      </div>
    </Layout>
  );
}
