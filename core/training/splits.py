"""Divisao temporal com purga para o treino (somente biblioteca padrao).

Por que nao dividir por ticker: ativos da mesma data compartilham o fator de mercado, e os rotulos
de N pregoes se sobrepoem no tempo. Treinar em alguns tickers e validar nos outros, nas mesmas datas,
vaza informacao e infla a metrica (Lopez de Prado, "Advances in Financial Machine Learning", cap. 7).

Aqui: treino = passado, validacao = futuro, e as amostras de treino cujo rotulo olha para dentro da
janela de validacao sao removidas (purga).
"""

import math
from datetime import datetime, timedelta


def _day(ts):
    return datetime.fromisoformat(str(ts).replace('Z', '+00:00')).date()


def temporal_purged_split(timestamps, test_size=0.2, horizon_days=5):
    """Retorna (train_idx, val_idx).

    - val_idx: amostras das ultimas datas (fracao `test_size` das datas unicas);
    - train_idx: amostras anteriores ao corte cujo rotulo (horizon_days pregoes ~ calendario) termina
      antes do inicio da validacao.
    """
    days = [_day(t) for t in timestamps]
    unique = sorted(set(days))
    if len(unique) < 4:
        raise ValueError('Datas distintas insuficientes para uma divisao temporal.')

    cut_pos = min(len(unique) - 1, max(1, int(len(unique) * (1 - test_size))))
    cutoff = unique[cut_pos]
    purge = timedelta(days=math.ceil(horizon_days * 7 / 5) + 1)

    train_idx = [i for i, d in enumerate(days) if d + purge < cutoff]
    val_idx = [i for i, d in enumerate(days) if d >= cutoff]
    if not train_idx or not val_idx:
        raise ValueError('Divisao temporal resultou em treino ou validacao vazios.')
    return train_idx, val_idx
