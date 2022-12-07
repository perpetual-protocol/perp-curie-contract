import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    BaseToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, b2qExactInput, b2qExactOutput, closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse badDebt", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let exchange: TestExchange
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let lowerTick: number, upperTick: number

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%

        fixture = await loadFixture(createClearingHouseFixture(undefined, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        exchange = fixture.exchange as TestExchange
        vault = fixture.vault
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool

        const initPrice = "100"
        const { maxTick, minTick } = await initMarket(fixture, initPrice, 1000)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        lowerTick = minTick
        upperTick = maxTick

        // prepare collateral for alice
        const decimals = await collateral.decimals()
        await collateral.mint(alice.address, parseUnits("100000", decimals))
        await deposit(alice, vault, 100000, collateral)

        // prepare collateral for bob
        await collateral.mint(bob.address, parseUnits("100", decimals))
        await deposit(bob, vault, 100, collateral)

        // prepare collateral for carol
        await collateral.mint(carol.address, parseUnits("1000000", decimals))
        await deposit(carol, vault, 1000000, collateral)

        // alice add liquidity
        await addOrder(fixture, alice, "500", "50000", lowerTick, upperTick, false)

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
    })

    describe("close/reduce position when bad debt", () => {
        describe("taker has long position and market price becomes lower than mark price", async () => {
            beforeEach(async () => {
                // bob long base Token with 8x leverage
                // bob open notional: -800
                // bob position size: 7.866265610482054835
                await q2bExactInput(fixture, bob, "800", baseToken.address)

                // To ignore funding payment
                await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

                // bob long base token for a 30 mins to manipulate mark price
                await forwardBothTimestamps(clearingHouse, 1800)
                // carol short base token that causing bob has bad debt(if he close his position)
                await b2qExactInput(fixture, carol, "5000", baseToken.address)

                // markPrice: 103.220570574410499733
                // marketPrice: 0.828815379024741938

                // position pnl: 7.866265610482054835 * 103.220570574410499733 - 800 = 11.9604246038
                // pendingFunding: -0.000291449334489317
                // bob's account value: 100 + 0.000291449334489317 + 11.9604246038 = 111.9607160531
                // bob's account value should be greater than 0 because it's calculated by mark price
                expect(await clearingHouse.getAccountValue(bob.address)).to.be.eq(parseEther("111.960716"))

                // to avoid over maxTickCrossedPerBlock
                await forwardBothTimestamps(clearingHouse, 5)
                // markPrice: 101.025123697070076996
                // marketPrice: 0.828815379024741938
            })

            it("cannot close position when user has bad debt", async () => {
                // bob close position
                // exchanged notional: 6.510
                // realized PnL: 6.510 - 800 = -793.490
                // account value: 100 - 800 + 6.510 = -693.49 (bad debt)
                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_NEMRM")
            })

            it("cannot reduce position when user has bad debt", async () => {
                // bob short 2 ETH to reduce position
                // exchanged notional: 1.655
                // realized PnL: 1.655 - 2/7.866 * 800 = -201.7520684
                // account value: 100 + 5.866 * 101.025123697070076996 - 800 + 1.65 = -105.736624393 (bad debt)
                await expect(b2qExactInput(fixture, bob, "2", baseToken.address)).to.be.revertedWith("CH_NEMRM")
            })

            it("cannot reduce when not resulting bad debt but with not enough collateral", async () => {
                // bob short 0.5 ETH to reduce position
                // exchanged notional: 0.4139
                // realized PnL: 0.4139 - 0.5/7.866 * 800 = -50.438
                // account value: 100 + 7.366 * 101.025123697070076996 - 800 + 0.4139 = 44.5649611526 (no bad debt)
                // free collateral: 100 - 50.438 - (800 - 0.4139 + 50.438) * 10% = -35.440
                await expect(b2qExactInput(fixture, bob, "0.5", baseToken.address)).to.be.revertedWith("CH_NEFCI")
            })

            it("can reduce when not resulting bad debt and has enough collateral", async () => {
                // bob short 0.1 ETH to reduce position
                // exchanged notional: 0.083
                // bob's realized PnL: 0.083 - 0.1/7.866 * 800 = -10.087
                // bob's unrealized PnL: 7.766 * 101.025123697070076996 + (-800 + 0.083 + 10.087) = -5.2688893686
                // bob's account value: 100 -10.087 -5.2688893686 = 84.6441106314 (no bad debt)
                // bob's free collateral: 100 -10.087 -5.2688893686 - (800 - 0.083 - 10.087) * 10% = 5.6611106314 > 0
                await expect(b2qExactInput(fixture, bob, "0.1", baseToken.address)).to.emit(
                    clearingHouse,
                    "PositionChanged",
                )
            })

            it("cannot close position with partial close when trader has bad debt", async () => {
                // set max price impact to 0.1% to trigger partial close
                await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 10)

                // partial close bob's position: 7.866 * 25% = 1.88784
                // exchanged notional: 1.629
                // realized PnL: 1.629 - 800 * 0.25 = -198.371
                // account value: 100 + 7.866 * 75% * 101.025123697070076996 - 800 + 1.629 = -102.3732827491 (bad debt)
                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_NEMRM")
            })
        })

        describe("taker has long position and mark price becomes lower than market price", async () => {
            beforeEach(async () => {
                // bob long base Token with 8x leverage
                // bob position size: 7.866
                await q2bExactInput(fixture, bob, "800", baseToken.address)

                // carol short base token for a 30 mins to manipulate mark price
                await b2qExactOutput(fixture, carol, "10000", baseToken.address)
                await forwardBothTimestamps(clearingHouse, 1800)
                await closePosition(fixture, carol)

                // mark price becomes lower than market price, bob has bad debt(calc by mark price)
                // markPrice: 66.712342714851817157
                // marketPrice: 103.222348825600000001
                expect(await clearingHouse.getAccountValue(bob.address)).to.be.lt("0")
            })

            // trader can close position even when his margin ratio is negative as long as he does not incur bad debt
            it("can close position when taker has bad debt(calc by mark price) but actually not(calc by market price)", async () => {
                await closePosition(fixture, bob)
            })

            // on the contrary, the trader might not be able to reduce position because
            // the remaining position might still incur bad debt due to the bad index price
            it("cannot reduce position when taker has bad debt(calc by mark price) but actually not(calc by market price)", async () => {
                // bob short 1 ETH to reduce position
                // exchanged notional: 103.013
                // realized PnL: 103.013 - 1/7.866 * 800 = 1.20991652
                // account value: 100 + 6.866 * 66.712342714851817157 - 800 + 103.013 = -138.9400549198 (bad debt)
                await expect(b2qExactInput(fixture, bob, "1", baseToken.address)).to.be.revertedWith("CH_NEMRM")
            })
        })
    })
})
