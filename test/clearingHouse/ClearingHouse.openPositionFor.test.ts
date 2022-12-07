import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    DelegateApproval,
    TestAccountBalance,
    TestClearingHouse,
    TestLimitOrderBook,
    UniswapV3Pool,
} from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { priceToTick } from "../helper/number"
import { mintAndDeposit } from "../helper/token"
import { syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseWithDelegateApprovalFixture, createClearingHouseWithDelegateApprovalFixture } from "./fixtures"

describe("ClearingHouse openPositionFor", () => {
    const [admin, maker, trader, keeper, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])

    let fixture: ClearingHouseWithDelegateApprovalFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let delegateApproval: DelegateApproval
    let limitOrderBook: TestLimitOrderBook

    const emptyAddress = "0x0000000000000000000000000000000000000000"

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseWithDelegateApprovalFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        pool = fixture.pool
        delegateApproval = fixture.delegateApproval
        limitOrderBook = fixture.limitOrderBook

        const pool1LowerTick: number = priceToTick(2900, await pool.tickSpacing())
        const pool1UpperTick: number = priceToTick(3100, await pool.tickSpacing())

        const initPrice = "2960"
        await initMarket(fixture, initPrice, undefined, 0)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        // prepare collateral for maker
        await mintAndDeposit(fixture, maker, 1_000_000_000_000)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("3000"),
            quote: parseEther("10000000"),
            lowerTick: pool1LowerTick,
            upperTick: pool1UpperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        await mintAndDeposit(fixture, trader, 1000)
    })

    it("a contract can open position for trader", async () => {
        const openPositionParams = {
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            amount: parseEther("300"),
            oppositeAmountBound: parseEther("0.1"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        }

        // fails before approving
        await expect(
            limitOrderBook.connect(keeper).openPositionFor(trader.address, openPositionParams),
        ).to.be.revertedWith("CH_SHNAOPT")

        await delegateApproval.connect(trader).approve(limitOrderBook.address, fixture.clearingHouseOpenPositionAction)

        await expect(limitOrderBook.connect(keeper).openPositionFor(trader.address, openPositionParams)).to.emit(
            clearingHouse,
            "PositionChanged",
        )
        expect(await accountBalance.getTakerPositionSize(trader.address, baseToken.address)).to.gte(parseEther("0.1"))
        expect(await accountBalance.getTakerOpenNotional(trader.address, baseToken.address)).to.be.eq(
            parseEther("-300"),
        )
    })

    it("an EOA can open position for trader", async () => {
        const openPositionParams = {
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            amount: parseEther("300"),
            oppositeAmountBound: parseEther("0.1"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        }

        // fails before approving
        await expect(
            clearingHouse.connect(alice).openPositionFor(trader.address, openPositionParams),
        ).to.be.revertedWith("CH_SHNAOPT")

        await delegateApproval.connect(trader).approve(alice.address, fixture.clearingHouseOpenPositionAction)

        await expect(clearingHouse.connect(alice).openPositionFor(trader.address, openPositionParams)).to.emit(
            clearingHouse,
            "PositionChanged",
        )
        expect(await accountBalance.getTakerPositionSize(trader.address, baseToken.address)).to.gte(parseEther("0.1"))
        expect(await accountBalance.getTakerOpenNotional(trader.address, baseToken.address)).to.be.eq(
            parseEther("-300"),
        )
    })

    it("trader approves itself to call openPositionFor()", async () => {
        await delegateApproval.connect(trader).approve(trader.address, fixture.clearingHouseOpenPositionAction)

        const openPositionParams = {
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            amount: parseEther("300"),
            oppositeAmountBound: parseEther("0.1"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        }

        await expect(clearingHouse.connect(trader).openPositionFor(trader.address, openPositionParams)).to.emit(
            clearingHouse,
            "PositionChanged",
        )
        expect(await accountBalance.getTakerPositionSize(trader.address, baseToken.address)).to.gte(parseEther("0.1"))
        expect(await accountBalance.getTakerOpenNotional(trader.address, baseToken.address)).to.be.eq(
            parseEther("-300"),
        )
    })

    it("force error, trader doesn't approve itself to call openPositionFor()", async () => {
        const openPositionParams = {
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            amount: parseEther("300"),
            oppositeAmountBound: parseEther("0.1"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        }

        await expect(
            clearingHouse.connect(trader).openPositionFor(trader.address, openPositionParams),
        ).to.be.revertedWith("CH_SHNAOPT")
    })

    describe("ClearingHouse setDelegateApproval", async () => {
        it("set a new DelegateApproval", async () => {
            await delegateApproval
                .connect(trader)
                .approve(limitOrderBook.address, fixture.clearingHouseOpenPositionAction)

            const openPositionParams = {
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("300"),
                oppositeAmountBound: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            }

            await expect(limitOrderBook.connect(keeper).openPositionFor(trader.address, openPositionParams)).to.emit(
                clearingHouse,
                "PositionChanged",
            )

            // set a new DelegateApproval, approvals would be reset
            const delegateApprovalFactory = await ethers.getContractFactory("DelegateApproval")
            const newDelegateApproval = await delegateApprovalFactory.deploy()
            await newDelegateApproval.initialize()

            await expect(clearingHouse.setDelegateApproval(newDelegateApproval.address))
                .to.emit(clearingHouse, "DelegateApprovalChanged")
                .withArgs(newDelegateApproval.address)

            expect(await clearingHouse.getDelegateApproval()).to.be.eq(newDelegateApproval.address)

            await expect(
                limitOrderBook.connect(keeper).openPositionFor(trader.address, openPositionParams),
            ).to.be.revertedWith("CH_SHNAOPT")
        })

        it("force error, set an empty address", async () => {
            await expect(clearingHouse.setDelegateApproval(emptyAddress)).to.be.revertedWith("CH_DANC")
        })

        it("force error, forget to set DelegateApproval", async () => {
            // manually set DelegateApproval to an empty address
            // to simulate that we forget to call setDelegateApproval()
            // after upgrading ClearingHouse
            await expect(clearingHouse.setDelegateApprovalUnsafe(emptyAddress))
                .to.emit(clearingHouse, "DelegateApprovalChanged")
                .withArgs(emptyAddress)

            expect(await clearingHouse.getDelegateApproval()).to.be.eq(emptyAddress)

            const openPositionParams = {
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("300"),
                oppositeAmountBound: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            }

            await expect(
                limitOrderBook.connect(keeper).openPositionFor(trader.address, openPositionParams),
            ).to.be.revertedWith("function call to a non-contract account")

            await expect(
                clearingHouse.connect(trader).openPositionFor(trader.address, openPositionParams),
            ).to.be.revertedWith("function call to a non-contract account")
        })
    })
})
