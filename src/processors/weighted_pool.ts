import { weighted_pool } from "../types/aptos/testnet/amm";
import { bigintToInteger, getCoinDecimals, scaleDown } from "../utils";

import { Gauge } from "@sentio/sdk";
import { AptosContext } from "@sentio/sdk/lib/aptos";

const START_VERSION = 396264510;

const NULL_TYPE = `${weighted_pool.DEFAULT_OPTIONS.address}::base_pool::Null`;

// all coin prices are relative to coin0
const coin1PriceGauge = Gauge.register("weighted_price_coin_1", {
  sparse: true,
});
const coin2PriceGauge = Gauge.register("weighted_price_coin_2", {
  sparse: true,
});
const coin3PriceGauge = Gauge.register("weighted_price_coin_3", {
  sparse: true,
});

export function processor() {
  weighted_pool
    .bind({ startVersion: START_VERSION })
    .onEventSwapEvent(
      (event: weighted_pool.SwapEventInstance, ctx: AptosContext) => {
        const { coins, weights } = getCoinsAndWeights(event);
        const poolTag = getPoolTag(coins, weights);
        const { coin1Price, coin2Price, coin3Price } = getPrices(
          event,
          coins,
          weights
        );
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
          type: "weighted",
        }

        ctx.meter
          .Counter("weighted_volume_coin_0")
          .add(volumeCoin0, { poolTag });

        ctx.meter
          .Counter("weighted_fee_coin_0")
          .add(feeCoin0, { poolTag });

        ctx.logger.log(
          1,
          `swap: ${swapAmountIn} ${coinAddressIn} for ${swapAmountOut} ${coinAddressOut} in weighted_pool`,
          swapAttributes
        );
      }
    );
}

// get the price of coin 1, 2, 3 quoted based on coin 0 from SwapEventInstance
// if any coin is Null, the price is undefined
function getPrices(
  event: weighted_pool.SwapEventInstance,
  coins: string[],
  weights: number[]
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

  // https://docs.balancer.fi/v/v1/core-concepts/protocol/index#spot-price
  // price1 = (balance0 / balance1) * (weight1 / weight0)
  const coin1Price =
    (balance0.div(balance1).toNumber() * weights[1]) / weights[0];

  let coin2Price: number | undefined;
  let coin3Price: number | undefined;

  if (numCoins > 2) {
    const balance2 = scaleDown(
      event.data_typed.pool_balance_2,
      getCoinDecimals(coins[2])
    );
    coin2Price = (balance0.div(balance2).toNumber() * weights[2]) / weights[0];
  }

  if (numCoins > 3) {
    const balance3 = scaleDown(
      event.data_typed.pool_balance_3,
      getCoinDecimals(coins[2])
    );
    coin3Price = (balance0.div(balance3).toNumber() * weights[3]) / weights[0];
  }

  return {
    coin1Price,
    coin2Price,
    coin3Price,
  };
}

function getCoinsAndWeights(event: weighted_pool.SwapEventInstance): {
  coins: string[];
  weights: number[];
} {
  const coins = [];
  const weights = [];
  coins.push(event.type_arguments[0]);
  coins.push(event.type_arguments[1]);

  weights.push(parseWeight(event.type_arguments[4]));
  weights.push(parseWeight(event.type_arguments[5]));

  const coin2 = event.type_arguments[2];
  if (!isNullType(coin2)) {
    coins.push(coin2);
    weights.push(parseWeight(event.type_arguments[6]));
  }

  const coin3 = event.type_arguments[3];
  if (!isNullType(coin3)) {
    coins.push(coin3);
    weights.push(parseWeight(event.type_arguments[7]));
  }

  return { coins, weights };
}

// weight typeArg format is like "0x1234::weighted_pool::Weight_5"
// returns the floating point number e.g. 0.05
function parseWeight(typeArg: string): number {
  const list = typeArg.split("_");
  return parseFloat(list[list.length - 1]) / 100;
}

function isNullType(typeArg: string): boolean {
  return typeArg === NULL_TYPE;
}

// use "WP-123456coin0Name-100000coin1Name-200000coin2Name-300000coin3Name-weight0-weight1-weight2-weight3" as unique tag for each pool
// the first 6 digits of coin address are used to reduce the length of the tag
function getPoolTag(coins: string[], weights: number[]): string {
  const concatCoins = coins
    .map((coin) => {
      const fragments = coin.split("::");
      return fragments[0].slice(2, 8) + fragments[fragments.length - 1];
    })
    .join("-");
  const concatWeights = weights.join("-");
  return `WP-${concatCoins}-${concatWeights}`;
}
