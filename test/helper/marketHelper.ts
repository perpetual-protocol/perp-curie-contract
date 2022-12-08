import { getMaxTick, getMaxTickRange, getMinTick } from "./number"

import { BigNumberish } from "ethers"
import { ethers } from "hardhat"
import { ClearingHouseFixture } from "../clearingHouse/fixtures"
import { forwardRealTimestamp } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"

// 1. uniFeeRatio comes from createClearingHouseFixture()
// 2. for tests irrelevant to fees, we often skip the assignments of exFeeRatio & ifFeeRatio
// 3. the correct value for no assignment should be "undefined"
export async function initMarket(
    fixture: ClearingHouseFixture,
    initPrice: string, // using string cuz there are prices with many decimal points
    exFeeRatio: BigNumberish = 10000, // 1%
    ifFeeRatio: BigNumberish = 100000, // 10%
    maxTickCrossedWithinBlock: number = getMaxTickRange(),
    baseToken: string = fixture.baseToken.address,
): Promise<{ minTick: number; maxTick: number }> {
    const poolAddr = await fixture.uniV3Factory.getPool(baseToken, fixture.quoteToken.address, fixture.uniFeeTier)

    const uniPoolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const uniPool = uniPoolFactory.attach(poolAddr)
    await uniPool.initialize(encodePriceSqrt(initPrice, "1"))
    const uniFeeRatio = await uniPool.fee()
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

    // In order to calculate mark price, we need market twap (30m) and market twap (15m)
    // Will get `OLD` revert message, if we don't forward timestamp
    await forwardRealTimestamp(2000)

    const tickSpacing = await uniPool.tickSpacing()
    return { minTick: getMinTick(tickSpacing), maxTick: getMaxTick(tickSpacing) }
}
