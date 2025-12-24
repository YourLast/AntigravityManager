/**
 * Quota Dashboard Component
 * 配额仪表盘 - 显示每个账号的 RPM、配额百分比和健康状态
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ipc } from '@/ipc/manager';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Loader2, Activity, AlertTriangle, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AccountQuotaMetrics {
  accountId: string;
  email: string;
  rpm: number;
  isRateLimited: boolean;
  cooldownUntil: number | null;
  quotaPercentage: number | null;
  resetTime: string | null;
}

interface QuotaMetricsResponse {
  metrics: AccountQuotaMetrics[];
  serverRunning: boolean;
  error?: string;
}

export function QuotaDashboard() {
  const { t } = useTranslation();

  const { data, isLoading, isError, refetch, isFetching } = useQuery<QuotaMetricsResponse>({
    queryKey: ['quotaMetrics'],
    queryFn: async () => {
      const result = await ipc.client.gateway.getQuotaMetrics();
      return result as QuotaMetricsResponse;
    },
    refetchInterval: 5000, // 每 5 秒刷新
    staleTime: 3000,
  });

  // 获取健康状态颜色和图标
  const getHealthStatus = (metrics: AccountQuotaMetrics) => {
    if (metrics.isRateLimited) {
      return {
        color: 'destructive' as const,
        icon: <XCircle className="h-4 w-4" />,
        label: t('dashboard.rateLimited', '限流中'),
      };
    }
    if (metrics.quotaPercentage !== null) {
      if (metrics.quotaPercentage < 5) {
        return {
          color: 'destructive' as const,
          icon: <AlertTriangle className="h-4 w-4" />,
          label: t('dashboard.depleted', '已耗尽'),
        };
      }
      if (metrics.quotaPercentage < 20) {
        return {
          color: 'secondary' as const,
          icon: <AlertTriangle className="h-4 w-4" />,
          label: t('dashboard.low', '配额低'),
        };
      }
    }
    return {
      color: 'default' as const,
      icon: <CheckCircle className="h-4 w-4" />,
      label: t('dashboard.healthy', '健康'),
    };
  };

  // 计算冷却剩余时间
  const getCooldownRemaining = (cooldownUntil: number | null) => {
    if (!cooldownUntil) return null;
    const remaining = Math.max(0, cooldownUntil - Date.now());
    if (remaining <= 0) return null;
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // 格式化重置时间
  const formatResetTime = (resetTime: string | null) => {
    if (!resetTime) return null;
    try {
      const date = new Date(resetTime);
      const now = new Date();
      const diff = date.getTime() - now.getTime();
      if (diff <= 0) return t('dashboard.resetting', '重置中...');
      const hours = Math.floor(diff / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      return `${hours}h ${minutes}m`;
    } catch {
      return null;
    }
  };

  if (!data?.serverRunning) {
    return (
      <Card className="border-dashed">
        <CardContent className="text-muted-foreground py-6 text-center">
          <Activity className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p>{t('dashboard.serverNotRunning', '代理服务未启动')}</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  if (isError || data?.error) {
    return (
      <Card className="border-destructive">
        <CardContent className="text-destructive py-6 text-center">
          <AlertTriangle className="mx-auto mb-2 h-8 w-8" />
          <p>{t('dashboard.error', '获取配额指标失败')}</p>
        </CardContent>
      </Card>
    );
  }

  const metrics = data?.metrics || [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="h-5 w-5" />
              {t('dashboard.title', '配额仪表盘')}
            </CardTitle>
            <CardDescription>
              {t('dashboard.description', '实时监控账号 RPM 和配额使用情况')}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {metrics.length === 0 ? (
          <div className="text-muted-foreground py-4 text-center">
            {t('dashboard.noAccounts', '暂无账号数据')}
          </div>
        ) : (
          metrics.map((account) => {
            const health = getHealthStatus(account);
            const cooldownRemaining = getCooldownRemaining(account.cooldownUntil);
            const resetTimeDisplay = formatResetTime(account.resetTime);

            return (
              <div
                key={account.accountId}
                className="bg-card hover:bg-accent/50 rounded-lg border p-3 transition-colors"
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="max-w-[200px] truncate text-sm font-medium">
                      {account.email}
                    </span>
                    <Badge variant={health.color} className="flex items-center gap-1 text-xs">
                      {health.icon}
                      {health.label}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground flex items-center gap-3 text-xs">
                    <span className="font-mono">
                      RPM: <span className="text-foreground font-semibold">{account.rpm}</span>/60
                    </span>
                    {resetTimeDisplay && (
                      <span>
                        {t('dashboard.resetsIn', '重置')}: {resetTimeDisplay}
                      </span>
                    )}
                  </div>
                </div>

                {/* 配额进度条 */}
                <div className="space-y-1">
                  <div className="text-muted-foreground flex justify-between text-xs">
                    <span>{t('dashboard.quota', '配额')}</span>
                    <span>
                      {account.quotaPercentage !== null
                        ? `${account.quotaPercentage.toFixed(1)}%`
                        : t('dashboard.unknown', '未知')}
                    </span>
                  </div>
                  <Progress value={account.quotaPercentage ?? 0} className="h-2" />
                </div>

                {/* 冷却倒计时 */}
                {cooldownRemaining && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-orange-500">
                    <AlertTriangle className="h-3 w-3" />
                    {t('dashboard.cooldownRemaining', '冷却剩余')}: {cooldownRemaining}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
