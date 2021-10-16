import { ClearingHouseFixture } from "../clearingHouse/fixtures"
import { BigNumberish } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { encodePriceSqrt } from "../shared/utilities"
import { getMaxTick, getMinTick } from "./number"
import { ethers } from "hardhat"

export async function initMarket(
    fixture: ClearingHouseFixture,
    initPrice: BigNumberish,
    exFeeRatio: BigNumberish,
    ifFeeRatio: BigNumberish,
    baseToken: string = fixture.baseToken.address,
): Promise<{ minTick: number; maxTick: number }> {
    fixture.mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
        return [0, parseUnits(initPrice.toString(), 6), 0, 0, 0]
    })

    const poolAddr = await fixture.uniV3Factory.getPool(baseToken, fixture.quoteToken.address, fixture.uniFeeTier)

    const uniPoolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const uniPool = uniPoolFactory.attach(poolAddr)
    await uniPool.initialize(encodePriceSqrt(initPrice.toString(), "1"))
    const uniFeeRatio = uniPool.fee()
    const tickSpacing = await uniPool.tickSpacing()

    // the initial number of oracle can be recorded is 1; thus, have to expand it
    await uniPool.increaseObservationCardinalityNext((2 ^ 16) - 1)

    // update config
    const marketRegistry = fixture.marketRegistry
    await marketRegistry.addPool(baseToken, uniFeeRatio)
    await marketRegistry.setFeeRatio(baseToken, exFeeRatio)
    await marketRegistry.setInsuranceFundFeeRatio(baseToken, ifFeeRatio)

    return { minTick: getMinTick(tickSpacing), maxTick: getMaxTick(tickSpacing) }
}
