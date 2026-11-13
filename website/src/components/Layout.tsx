import { Button } from "@/components/ui/button";
import { Github, Menu, X } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { ModeToggle } from "./ModeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { DOCS_URL, ISSUES_URL, RELEASES_URL, REPO_URL, UPSTREAM_URL } from "@/const";

function Logo({ className }: { className?: string }) {
  return (
    <>
      <img src="/logo.svg" alt="" className={`${className ?? ""} dark:hidden`} />
      <img src="/logo-dark.svg" alt="" className={`${className ?? ""} hidden dark:block`} />
    </>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="min-h-screen flex flex-col bg-background font-sans">
      <header className="sticky top-0 z-50 w-full border-b border-border bg-background/85 backdrop-blur">
        <div className="container flex h-14 items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Logo className="h-7 w-7" />
            <span className="font-semibold text-lg tracking-tight">dugong</span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <a href={DOCS_URL}>{t("nav.docs")}</a>
            </Button>
            <Button variant="ghost" size="icon" asChild>
              <a href={REPO_URL} target="_blank" rel="noreferrer" title={t("nav.github")}>
                <Github className="h-5 w-5" />
              </a>
            </Button>
            <LanguageToggle />
            <ModeToggle />
            <Button size="sm" className="ml-2" asChild>
              <a href="#install">{t("nav.getStarted")}</a>
            </Button>
          </nav>

          <div className="flex items-center gap-1 md:hidden">
            <LanguageToggle />
            <ModeToggle />
            <Button variant="ghost" size="icon" onClick={() => setIsMenuOpen(!isMenuOpen)} title={t("nav.menu")}>
              {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {isMenuOpen && (
          <div className="md:hidden border-t border-border bg-background p-4">
            <nav className="flex flex-col gap-2">
              <Button className="w-full" asChild>
                <a href="#install" onClick={() => setIsMenuOpen(false)}>{t("nav.getStarted")}</a>
              </Button>
              <Button variant="outline" className="w-full" asChild>
                <a href={DOCS_URL}>{t("nav.docs")}</a>
              </Button>
              <Button variant="outline" className="w-full" asChild>
                <a href={REPO_URL} target="_blank" rel="noreferrer">
                  <Github className="h-4 w-4" /> {t("nav.github")}
                </a>
              </Button>
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border py-12">
        <div className="container grid grid-cols-1 md:grid-cols-3 gap-8 text-sm">
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center gap-2">
              <Logo className="h-6 w-6" />
              <span className="font-semibold tracking-tight">dugong</span>
            </div>
            <p className="text-muted-foreground max-w-sm">{t("footer.tagline")}</p>
            <p className="text-muted-foreground">{t("footer.license")}</p>
          </div>

          <div>
            <h3 className="font-semibold mb-3">{t("footer.project")}</h3>
            <ul className="space-y-2 text-muted-foreground">
              <li><a href={DOCS_URL} className="hover:text-foreground">{t("footer.docs")}</a></li>
              <li><a href={REPO_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">GitHub</a></li>
              <li><a href={RELEASES_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">{t("footer.releases")}</a></li>
              <li><a href={ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">{t("footer.issues")}</a></li>
              <li><a href={`${DOCS_URL}privacy.html`} className="hover:text-foreground">{t("footer.privacy")}</a></li>
              <li><a href={UPSTREAM_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">{t("footer.upstream")}</a></li>
            </ul>
          </div>
        </div>
      </footer>
    </div>
  );
}
