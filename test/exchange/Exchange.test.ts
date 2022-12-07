import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { addOrder, closePosition, q2bExactInput, removeAllOrders } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { syncIndexToMarketPrice } from "../shared/utilities"

describe("Exchange complicated test", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        vault = fixture.vault
        usdc = fixture.USDC
        pool = fixture.pool
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher

        usdcDecimals = await usdc.decimals()

        const initPrice = "151.373306858723226652"
        await initMarket(fixture, initPrice)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        // taker mint
        await usdc.mint(taker.address, parseUnits("10000000", usdcDecimals))
        await deposit(taker, vault, 1000000, usdc)

        // maker mint
        await usdc.mint(maker.address, parseUnits("10000000", usdcDecimals))
        await deposit(maker, vault, 1000000, usdc)
    })

    describe("exchange should fail in the following scenarios", async () => {
        it("no liquidity", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 200, 100000, 0, 150000)

            // taker open position
            await q2bExactInput(fixture, taker, 100)

            // maker remove all liquidity
            await removeAllOrders(fixture, maker)

            // taker close position should be revert
            await expect(closePosition(fixture, taker)).to.be.revertedWith("CH_F0S")

            // maker close position should be revert
            await expect(closePosition(fixture, maker)).to.be.revertedWith("CH_F0S")
        })
    })
})
