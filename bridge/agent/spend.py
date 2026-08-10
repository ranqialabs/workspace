"""What a run cost, in tokens and in an estimate of money.

Pure and total, like `progress`: a run is never worth failing over its own
footnote. An unpriced model, an unknown provider or a registry that has moved on
comes back as tokens with no money beside them, rather than as an exception.

Prices come from `genai-prices`, which is a best-effort registry rather than a
bill. Everything here says "approx." for that reason, and `cost` returns None when
it cannot do better than a guess.
"""

import contextlib
import logging
from dataclasses import dataclass
from decimal import Decimal

from genai_prices import calc_price
from pydantic_ai import ModelResponse
from pydantic_ai.usage import RunUsage

log = logging.getLogger(__name__)

# Below this, a rounded cent reads as "$0.00" and says less than nothing; such a
# run gets an order of magnitude instead.
_CENT_FLOOR = Decimal("0.01")


@dataclass(frozen=True)
class Spend:
    """One run's usage, and what it is estimated to have cost.

    `usd` is None when nothing could price the model: the registry does not know
    it, or the response carried no model name. Tokens are counted either way,
    which is the half of this that is measured rather than estimated.
    """

    input_tokens: int
    output_tokens: int
    cached_tokens: int
    usd: Decimal | None

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


def of(usage: RunUsage, response: ModelResponse | None) -> Spend:
    """A run's usage, priced against the model that answered it.

    The whole run's tokens, but the last response's model and provider: those name
    who to price against, and a run does not switch providers halfway.
    """
    return Spend(
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cached_tokens=usage.cache_read_tokens,
        usd=_cost(usage, response),
    )


def _cost(usage: RunUsage, response: ModelResponse | None) -> Decimal | None:
    """The registry's price for this usage, or None if it has none.

    The provider and the request's own timestamp go in as well as the model:
    without the provider a model served by several is priced at whichever the
    registry lists first, and without the timestamp a price that changed mid
    conversation is applied to the turns that came before it. Tried by url first
    and then by provider id, which is the order `ModelResponse.cost` uses, since
    the url identifies a deployment and the id only names the vendor.

    `RunUsage` is handed over as it is: it implements `genai-prices`' own usage
    protocol, so there is nothing to convert.
    """
    if response is None or not (model := response.model_name):
        return None
    try:
        if response.provider_url:
            with contextlib.suppress(LookupError):
                return calc_price(
                    usage,
                    model,
                    provider_api_url=response.provider_url,
                    genai_request_timestamp=response.timestamp,
                ).total_price
        return calc_price(
            usage,
            model,
            provider_id=response.provider_name,
            genai_request_timestamp=response.timestamp,
        ).total_price
    except LookupError:
        # A model the registry does not know: a local deployment, a snapshot too
        # new, a provider it has never priced. Tokens without a price beats no
        # footnote at all, and certainly beats losing the run over one.
        log.debug("no price for %s", model, exc_info=True)
        return None


def footnote(spend: Spend) -> str:
    """`spend` as one clause, for the line under a finished run.

    Cached input is called out because it is the difference between a long
    conversation being cheap and being expensive, and it is the number a reader
    can act on: it says the history is being reused rather than re-read.
    """
    tokens = f"{spend.total_tokens:,} tokens"
    if spend.cached_tokens:
        tokens += f" ({spend.cached_tokens:,} cached)"
    # Unpriced, or priced at nothing measurable: either way the tokens say it
    # alone, since "approx. $0" beside 15 of them is a rounding artefact dressed
    # up as a price.
    if not spend.usd:
        return tokens
    return f"{tokens}, approx. {money(spend.usd)}"


def money(usd: Decimal) -> str:
    """An amount in USD, with enough places left to be worth reading.

    A run costing a fraction of a cent rounds to `$0.00` at two places, which
    reads as free rather than as small, so anything under a cent keeps two
    significant figures instead. `normalize` first, because the registry returns
    the amount at the scale its arithmetic landed on and `.2g` would otherwise
    render a trailing-zero Decimal in exponent form.
    """
    if usd >= _CENT_FLOOR:
        return f"${usd:,.2f}"
    return f"${usd.normalize():.2g}"
