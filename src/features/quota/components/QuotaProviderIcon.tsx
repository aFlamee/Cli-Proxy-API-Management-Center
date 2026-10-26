import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { QuotaProviderType } from '../providers/types';
import styles from './QuotaProviderIcon.module.scss';

/** A provider's logo on a small tile, or its initial when there is no logo. */
export function QuotaProviderIcon({
  provider,
  resolvedTheme,
  className,
}: {
  provider: QuotaProviderType;
  resolvedTheme: ResolvedTheme;
  className?: string;
}) {
  const { t } = useTranslation();
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const label = getTypeLabel(t, provider);
  return (
    <span
      className={className ? `${styles.providerIcon} ${className}` : styles.providerIcon}
      style={
        isThemeSurfaceIconProvider(provider)
          ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
          : undefined
      }
    >
      {iconSrc ? (
        <img src={iconSrc} alt="" />
      ) : (
        <span className={styles.providerIconFallback}>{label.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
