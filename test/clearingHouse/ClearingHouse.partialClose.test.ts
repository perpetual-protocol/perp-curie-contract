import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    TestClearingHouse,
    TestERC20,
    Vault,
} from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse partial close in xyk pool", () => {
    const [admin, maker, alice, carol, liquidator] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        clearingHouseConfig = fixture.clearingHouseConfig
        exchange = fixture.exchange
        accountBalance = fixture.accountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        const initPrice = "10"
        const { maxTick, minTick } = await initMarket(fixture, initPrice)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        lowerTick = minTick
        upperTick = maxTick

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for alice
        const aliceCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(alice.address, aliceCollateral)
        await collateral.connect(alice).approve(clearingHouse.address, aliceCollateral)
        await deposit(alice, vault, 1000, collateral)

        // prepare collateral for carol
        const carolCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(carol.address, carolCollateral)
        await collateral.connect(carol).approve(clearingHouse.address, carolCollateral)
        await deposit(carol, vault, 1000, collateral)

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
    })

    // https://docs.google.com/spreadsheets/d/1cVd-sM9HCeEczgmyGtdm1DH3vyoYEN7ArKfXx7DztEk/edit#gid=577678159
    describe("partial close", () => {
        beforeEach(async () => {
            // carol first shorts 25 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("2.5"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-2.5"))

            // move to next 15 secs to renew the over price checking window,to simplify test case
            await forwardBothTimestamps(clearingHouse, 15)

            // price delta for every tick is 0.01%
            // if we want to limit price impact to 1%, and 1% / 0.01% = 100
            // so limiting price impact to 1% means tick should not cross 100 ticks
            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)
        })

        it("carol reduces position with openPosition and it's not over price limit", async () => {
            // carol longs 0.1 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-2.4"))
        })

        // will auto partial close by max tick crossed
        it("can partial close a position", async () => {
            await expect(
                clearingHouse.connect(carol).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.not.reverted

            const positionSize = await accountBalance.getTotalPositionSize(carol.address, baseToken.address)
            expect(positionSize).to.not.eq(0)
        })

        it("force error, partial closing a position does not apply to opening a reverse position with openPosition", async () => {
            // carol longs 2.5 eth
            await expect(
                clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: ethers.constants.MaxUint256,
                    amount: parseEther("2.5"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.revertedWith("EX_OPLAS")
        })
    })

    // skip: partial close will auto calculate closed ratio by max tick crossed limit
    // solution for bad debt attack
    // https://www.notion.so/perp/isOverPriceLimit-974202d798d746e69a3bbd0ee866926b?d=f9557a7434aa4c0a9a9fe92c4efee682#da5dee7be5e4465dbde04ce522b6711a
    // only check the price before swap here
    // it hits the limit only when
    //  1.the first short cause the price impact less than ~1.2%
    //    (the price impact of the remaining position after partial close will be less than 1%)
    //  2.because we have price check after swap, the PnL for the attacker will be very small.
    //    if the fee ratio is too large(1%), the attack can't get any benefit from CH
    //    So, the fee ratio must be small (haven't had a precious number)
    describe.skip("bad debt attack: check price limit before swap", () => {
        beforeEach(async () => {
            // set fee ratio to 0.1%, it's easier to produce the attack
            await marketRegistry.setFeeRatio(baseToken.address, 1000)
            // move to next block to have finalTickLastBlock
            await forwardBothTimestamps(clearingHouse)
        })

        it("position closed partially, carol opens a short and alice open a large long which makes carol has bad debt", async () => {
            // 1. carol shorts 0.5 eth (price impact should be around 1.2%) and get quote 4.97, price now is 9.901
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.5"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 2. alice opens large long with 1000 quote and get base 50.325, price now is 39.742
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)

            // 3. carol can only close partial position, -(0.5 - 0.5/4) = -0.375
            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-0.375"))

            // 4. alice can only close partial position, 50.33 - 50.33/4 = 37.7475
            await clearingHouse.connect(alice).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(
                parseEther("37.762630707661446261"),
            )
        })

        it("force error, can not open a reverse pos, carol opens a short and alice open a large long which makes carol has bad debt", async () => {
            // 1. carol shorts 0.5 eth (price impact should be around 1.2%) and get quote 4.97, price now is 9.901
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.5"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 2. alice opens large long with 1000 quote and get base 50.325, price now is 39.742
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)

            // 3. carol can only close partial position, -(0.5 - 0.5/4) = -0.375
            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-0.375"))

            // 4. alice can not close her position through open a reverse position
            await expect(
                clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("1000"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("EX_OPLBS")

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(
                parseEther("50.350174276881928348"),
            )
        })
    })
})
