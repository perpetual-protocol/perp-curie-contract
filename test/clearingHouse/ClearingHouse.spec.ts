import { MockContract, smockit } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, UniswapV3Pool } from "../../typechain"
import { ADDR_GREATER_THAN, ADDR_LESS_THAN, mockedClearingHouseFixture, mockedTokenTo } from "./fixtures"

describe("ClearingHouse Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const POOL_B_ADDRESS = "0x000000000000000000000000000000000000000b"
    const DEFAULT_FEE = 3000

    let clearingHouse: ClearingHouse
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract
    let exchange: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(mockedClearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        baseToken = _clearingHouseFixture.mockedBaseToken
        quoteToken = _clearingHouseFixture.mockedQuoteToken
        uniV3Factory = _clearingHouseFixture.mockedUniV3Factory
        exchange = _clearingHouseFixture.mockedExchange

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        baseToken.smocked.getIndexPrice.will.return.with(parseEther("100"))
    })

    describe("onlyOwner setters", () => {
        it("setLiquidationPenaltyRatio", async () => {
            await expect(clearingHouse.setLiquidationPenaltyRatio(parseEther("2"))).to.be.revertedWith("CH_RO")
            await clearingHouse.setLiquidationPenaltyRatio(parseEther("0.5"))
            expect(await clearingHouse.liquidationPenaltyRatio()).eq(parseEther("0.5"))
        })

        it("setPartialCloseRatio", async () => {
            await expect(clearingHouse.setPartialCloseRatio(parseEther("2"))).to.be.revertedWith("CH_RO")
            await clearingHouse.setPartialCloseRatio(parseEther("0.5"))
            expect(await clearingHouse.partialCloseRatio()).eq(parseEther("0.5"))
        })

        // FIXME move to exchange spec
        it.skip("setMaxTickCrossedWithinBlock", async () => {
            await expect(clearingHouse.setMaxTickCrossedWithinBlock(baseToken.address, 200)).to.be.revertedWith(
                "CH_BTNE",
            )

            // add pool
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            const mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)

            await clearingHouse.setMaxTickCrossedWithinBlock(baseToken.address, 200)
            expect(await clearingHouse.getMaxTickCrossedWithinBlock(baseToken.address)).eq(200)
        })

        // FIXME move to exchange spec
        // FIXME change all ratio to uint24?
        it.skip("setFeeRatio", async () => {
            await expect(clearingHouse.setFeeRatio(baseToken.address, parseEther("2"))).to.be.revertedWith("CH_RO")
            await clearingHouse.setFeeRatio(baseToken.address, parseEther("0.5"))
            expect(await clearingHouse.getFeeRatio(baseToken.address)).eq(parseEther("0.5"))
        })
    })

    describe("# getRequiredCollateral", () => {})
})
