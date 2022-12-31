import { stable_pool } from "../types/aptos/testnet/amm";
import { bigintToInteger, getCoinDecimals, scaleDown } from "../utils";

import { Gauge } from "@sentio/sdk";
import { AptosContext } from "@sentio/sdk/lib/aptos";

const START_VERSION = 396264510;

const EPSILON = 0.00000001; // for detecting convergence in stableswap math
const MAX_LOOP_LIMIT = 100;

const NULL_TYPE = `${stable_pool.DEFAULT_OPTIONS.address}::base_pool::Null`;

// all coin prices are relative to coin0
const coin1PriceGauge = Gauge.register("stable_price_coin_1", { sparse: true });
const coin2PriceGauge = Gauge.register("stable_price_coin_2", { sparse: true });
const coin3PriceGauge = Gauge.register("stable_price_coin_3", { sparse: true });

export function processor() {
  stable_pool
    .bind({ startVersion: START_VERSION })
    .onEventSwapEvent(
      (event: stable_pool.SwapEventInstance, ctx: AptosContext) => {
        const coins = getCoins(event);
        const poolTag = getPoolTag(coins);
        const { coin1Price, coin2Price, coin3Price } = getPrices(event, coins);
        coin1PriceGauge.record(ctx, coin1Price, { poolTag });
        if (coin2Price) {
          coin2PriceGauge.record(ctx, coin2Price, { poolTag });
        }
        if (coin3Price) {
          coin3PriceGauge.record(ctx, coin3Price, { poolTag });
        }

        // volume is converted to coin0 amount
        const relativePricesToCoin0 = [
          1,
          coin1Price,
          coin2Price || 0,
          coin3Price || 0,
        ];
        const assetInIndex = bigintToInteger(event.data_typed.asset_in_index);
        const swapAmountIn = scaleDown(
          event.data_typed.amount_in,
          getCoinDecimals(event.type_arguments[assetInIndex])
        );
        const volumeCoin0 = swapAmountIn.multipliedBy(
          relativePricesToCoin0[assetInIndex]
        );

        const swapFee = scaleDown(
          event.data_typed.fee_amount,
          getCoinDecimals(event.type_arguments[assetInIndex])
        );
        const feeCoin0 = swapFee.multipliedBy(
          relativePricesToCoin0[assetInIndex]
        );

        const assetOutIndex = bigintToInteger(event.data_typed.asset_out_index);
        const swapAmountOut = scaleDown(
          event.data_typed.amount_out,
          getCoinDecimals(event.type_arguments[assetOutIndex])
        );

        const coinAddressIn = event.type_arguments[assetInIndex];
        const coinAddressOut = event.type_arguments[assetOutIndex];

        const swapAttributes = {
          coin_address_in: coinAddressIn,
          coin_address_out: coinAddressOut,
          amount_in: swapAmountIn,
          amount_out: swapAmountOut,
          fee_amount: event.data_typed.fee_amount,
          type: "stable"
        }

        ctx.meter.Counter("stable_volume_coin_0").add(volumeCoin0, { poolTag });
        ctx.meter
          .Counter("stable_fee_coin_0")
          .add(feeCoin0, { poolTag });

        ctx.logger.log(
          1,
          `swap: ${swapAmountIn} ${coinAddressIn} for ${swapAmountOut} ${coinAddressOut} in stable_pool`,
          swapAttributes
        );
      }
    );
}

// get the price of coin 1, 2, 3 quoted based on coin 0 from SwapEventInstance
// if any coin is Null, the price is undefined
function getPrices(
  event: stable_pool.SwapEventInstance,
  coins: string[]
): {
  coin1Price: number;
  coin2Price: number | undefined;
  coin3Price: number | undefined;
} {
  const numCoins = coins.length;

  const balance0 = scaleDown(
    event.data_typed.pool_balance_0,
    getCoinDecimals(coins[0])
  );
  const balance1 = scaleDown(
    event.data_typed.pool_balance_1,
    getCoinDecimals(coins[1])
  );

  const balances = [balance0.toNumber(), balance1.toNumber()];
  if (numCoins > 2) {
    const balance2 = scaleDown(
      event.data_typed.pool_balance_2,
      getCoinDecimals(coins[2])
    );
    balances.push(balance2.toNumber());
  }
  if (numCoins > 3) {
    const balance3 = scaleDown(
      event.data_typed.pool_balance_3,
      getCoinDecimals(coins[3])
    );
    balances.push(balance3.toNumber());
  }

  const amp = bigintToInteger(event.data_typed.amplification_factor);
  const d = getD(balances, amp);
  const coin1Price = getStablePrice(0, 1, balances, amp, d);
  const coin2Price =
    numCoins > 2 ? getStablePrice(0, 2, balances, amp, d) : undefined;
  const coin3Price =
    numCoins > 3 ? getStablePrice(0, 3, balances, amp, d) : undefined;

  return {
    coin1Price,
    coin2Price,
    coin3Price,
  };
}

function getCoins(event: stable_pool.SwapEventInstance): string[] {
  const coins = [];
  coins.push(event.type_arguments[0]);
  coins.push(event.type_arguments[1]);

  const coin2 = event.type_arguments[2];
  if (!isNullType(coin2)) {
    coins.push(coin2);
  }

  const coin3 = event.type_arguments[3];
  if (!isNullType(coin3)) {
    coins.push(coin3);
  }

  return coins;
}

function isNullType(typeArg: string): boolean {
  return typeArg === NULL_TYPE;
}

// use "SP-123456coin0Name-100000coin1Name-200000coin2Name-300000coin3Name" as unique tag for each pool
// the first 6 digits of coin address are used to reduce the length of the tag
function getPoolTag(coins: string[]): string {
  const concatCoins = coins
    .map((coin) => {
      const fragments = coin.split("::");
      return fragments[0].slice(2, 8) + fragments[fragments.length - 1];
    })
    .join("-");
  return `SP-${concatCoins}`;
}

// get relative price of coin j to i
// formula: https://linear.app/thala-labs/issue/THA-434/calculate-swap-price-impact
function getStablePrice(
  i: number,
  j: number,
  balances: number[],
  amp: number,
  d: number
): number {
  const n = balances.length;
  let b = Math.pow(d, n + 1) / Math.pow(n, n);
  balances.forEach((x: number, index: number) => {
    if (index != i && index != j) {
      b = b / x;
    }
  });
  let naxx = n * amp * balances[i] * balances[i] * balances[j] * balances[j];
  return (balances[i] * b + naxx) / (balances[j] * b + naxx);
}

// https://github.com/ThalaLabs/thalaswap-v1/blob/main/sources/stable_math.move#L54
function getD(xp: number[], a: number): number {
  const n = xp.length;

  // sum
  const s = xp.reduce((partialSum, a) => partialSum + a, 0);

  if (s == 0) {
    return 0;
  }

  let prev_d: number;
  let d = s;
  const ann = a * n;

  let i = 0;
  while (i < MAX_LOOP_LIMIT) {
    let dp = d;

    let j = 0;
    while (j < n) {
      dp = (dp * d) / (xp[j] * n);
      j = j + 1;
    }

    prev_d = d;
    d = ((ann * s + n * dp) * d) / ((ann - 1) * d + (n + 1) * dp);
    if (Math.abs(prev_d - d) < EPSILON) {
      return d;
    }

    i = i + 1;
  }

  throw new Error("not converged in getD");
}
