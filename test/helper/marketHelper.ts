import { MockContract } from "@eth-optimism/smock"
import { BigNumberish } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { ethers } from "hardhat"
import { UniswapV3Pool } from "../../typechain"
import { ClearingHouseFixture } from "../clearingHouse/fixtures"
import { encodePriceSqrt } from "../shared/utilities"
import { getMaxTick, getMinTick } from "./number"

export async function initMarket(
    fixture: ClearingHouseFixture,
    initPrice: BigNumberish,
    exFeeRatio: BigNumberish = 1000, // 0.1%
    ifFeeRatio: BigNumberish = 100000, // 10%
    maxTickCrossedWithinBlock: number = 0,
    baseToken: string = fixture.baseToken.address,
    mockedBaseAggregator: MockContract = fixture.mockedBaseAggregator,
): Promise<{ minTick: number; maxTick: number }> {
    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
        return [0, parseUnits(initPrice.toString(), 6), 0, 0, 0]
    })

    const poolAddr = await fixture.uniV3Factory.getPool(baseToken, fixture.quoteToken.address, fixture.uniFeeTier)

    const uniPoolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const uniPool = uniPoolFactory.attach(poolAddr)
    await uniPool.initialize(encodePriceSqrt(initPrice.toString(), "1"))
    const uniFeeRatio = uniPool.fee()
    const tickSpacing = await uniPool.tickSpacing()

    // the initial number of oracle can be recorded is 1; thus, have to expand it
    await uniPool.increaseObservationCardinalityNext(500)

    // update config
    const marketRegistry = fixture.marketRegistry
    await marketRegistry.addPool(baseToken, uniFeeRatio)
    await marketRegistry.setFeeRatio(baseToken, exFeeRatio)
    await marketRegistry.setInsuranceFundFeeRatio(baseToken, ifFeeRatio)

    if (maxTickCrossedWithinBlock != 0) {
        await fixture.exchange.setMaxTickCrossedWithinBlock(baseToken, maxTickCrossedWithinBlock)
    }

    return { minTick: getMinTick(tickSpacing), maxTick: getMaxTick(tickSpacing) }
}

export async function initAndAddPool(
    fixture: ClearingHouseFixture,
    pool: UniswapV3Pool,
    baseToken: string,
    sqrtPriceX96: BigNumberish,
    feeRatio: BigNumberish,
    maxTickCrossedWithinBlock: number,
) {
    await pool.initialize(sqrtPriceX96)
    // the initial number of oracle can be recorded is 1; thus, have to expand it
    await pool.increaseObservationCardinalityNext(500)
    // add pool after it's initialized
    await fixture.marketRegistry.addPool(baseToken, feeRatio)
    await fixture.exchange.setMaxTickCrossedWithinBlock(baseToken, maxTickCrossedWithinBlock)
}
