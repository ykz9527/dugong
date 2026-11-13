import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

export function LanguageToggle() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => i18n.changeLanguage(isZh ? "en" : "zh")}
      className="w-10"
      title={isZh ? "English" : "中文"}
    >
      {isZh ? "EN" : "中"}
    </Button>
  );
}
