import { normalizeLanguagePreference, setLanguagePreference, t } from '../lib/i18n';
import { useI18n } from '../lib/useI18n';

export default function LanguagePicker() {
  const { preference } = useI18n();
  return <select className="language-picker" aria-label={t('界面语言')}
    title={t('界面语言')} value={preference}
    onMouseDown={event => event.stopPropagation()}
    onChange={event => setLanguagePreference(normalizeLanguagePreference(event.currentTarget.value))}>
    <option value="system">{t('跟随系统')}</option>
    <option value="zh-CN">简体中文</option>
    <option value="en">English</option>
  </select>;
}
