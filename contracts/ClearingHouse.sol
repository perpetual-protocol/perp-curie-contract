// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { Funding } from "./lib/Funding.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { IVault } from "./interface/IVault.sol";
import { IExchange } from "./interface/IExchange.sol";
import { IOrderBook } from "./interface/IOrderBook.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { ClearingHouseStorageV1 } from "./storage/ClearingHouseStorage.sol";
import { BlockContext } from "./base/BlockContext.sol";
import { IClearingHouse } from "./interface/IClearingHouse.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract ClearingHouse is
    IUniswapV3MintCallback,
    IUniswapV3SwapCallback,
    IClearingHouse,
    BlockContext,
    ReentrancyGuardUpgradeable,
    OwnerPausable,
    BaseRelayRecipient,
    ClearingHouseStorageV1
{
    using AddressUpgradeable for address;
    using SafeMathUpgradeable for uint256;
    using SignedSafeMathUpgradeable for int256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using PerpSafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for uint160;
    using PerpMath for uint128;
    using PerpMath for int256;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;

    //
    // STRUCT
    //
    struct InternalOpenPositionParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        bool isClose;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool skipMarginRequirementCheck;
        Funding.Growth fundingGrowthGlobal;
    }

    struct InternalClosePositionParams {
        address trader;
        address baseToken;
        uint160 sqrtPriceLimitX96;
        Funding.Growth fundingGrowthGlobal;
    }

    struct InternalCheckSlippageParams {
        bool isBaseToQuote;
        bool isExactInput;
        uint256 deltaAvailableQuote;
        uint256 deltaAvailableBase;
        uint256 oppositeAmountBound;
    }

    //
    // MODIFIER
    //

    modifier onlyExchange() {
        // only exchange
        // For caller validation purposes it would be more efficient and more reliable to use
        // "msg.sender" instead of "_msgSender()" as contracts never call each other through GSN.
        require(msg.sender == _exchange, "CH_OE");
        _;
    }

    modifier checkDeadline(uint256 deadline) {
        // transaction expires
        require(_blockTimestamp() <= deadline, "CH_TE");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    /// @dev this function is public for testing
    // solhint-disable-next-line func-order
    function initialize(
        address clearingHouseConfigArg,
        address vaultArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        address exchangeArg,
        address accountBalanceArg
    ) public initializer {
        // CH_VANC: Vault address is not contract
        require(vaultArg.isContract(), "CH_VANC");
        // CH_QANC: QuoteToken address is not contract
        require(quoteTokenArg.isContract(), "CH_QANC");
        // CH_QDN18: QuoteToken decimals is not 18
        require(IERC20Metadata(quoteTokenArg).decimals() == 18, "CH_QDN18");
        // CH_UANC: UniV3Factory address is not contract
        require(uniV3FactoryArg.isContract(), "CH_UANC");
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "CH_CCNC");
        // AccountBalance is not contract
        require(accountBalanceArg.isContract(), "CH_ABNC");
        // CH_ANC: address is not contract
        require(exchangeArg.isContract(), "CH_ANC");

        address orderBookArg = IExchange(exchangeArg).getOrderBook();
        // orderBook is not contract
        require(orderBookArg.isContract(), "CH_OBNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        _clearingHouseConfig = clearingHouseConfigArg;
        _vault = vaultArg;
        _quoteToken = quoteTokenArg;
        _uniswapV3Factory = uniV3FactoryArg;
        _exchange = exchangeArg;
        _orderBook = orderBookArg;
        _accountBalance = accountBalanceArg;

        _settlementTokenDecimals = IVault(_vault).decimals();
    }

    // solhint-disable-next-line func-order
    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        // CH_ANC: address is not contract
        require(trustedForwarderArg.isContract(), "CH_ANC");
        _setTrustedForwarder(trustedForwarderArg);
        emit TrustedForwarderChanged(trustedForwarderArg);
    }

    /// @inheritdoc IClearingHouse
    function addLiquidity(AddLiquidityParams calldata params)
        external
        override
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (AddLiquidityResponse memory)
    {
        // input checks:
        //   baseToken: in Exchange.settleFunding()
        //   base & quote: in UniswapV3Broker.addLiquidity()
        //   lowerTick & upperTick: in UniswapV3Pool._modifyPosition()
        //   minBase, minQuote & deadline: here
        address trader = _msgSender();

        // register token if it's the first time
        IAccountBalance(_accountBalance).registerBaseToken(trader, params.baseToken);

        // must settle funding first
        Funding.Growth memory fundingGrowthGlobal = IExchange(_exchange).settleFunding(trader, params.baseToken);

        // note that we no longer check available tokens here because CH will always auto-mint in UniswapV3MintCallback
        IOrderBook.AddLiquidityResponse memory response =
            IOrderBook(_orderBook).addLiquidity(
                IOrderBook.AddLiquidityParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    base: params.base,
                    quote: params.quote,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");

        // if !useTakerBalance, takerBalance won't change, only need to collects fee to oweRealizedPnl
        if (params.useTakerBalance) {
            bool isBaseAdded = response.base > 0;
            bool isQuoteAdded = response.quote > 0;

            // can't add liquidity within range from take position
            require(isBaseAdded != isQuoteAdded, "CH_CALWRFTP");

            AccountMarket.Info memory accountMarketInfo =
                IAccountBalance(_accountBalance).getAccountInfo(trader, params.baseToken);

            // the signs of deltaBaseDebt and deltaQuoteDebt are always the opposite.
            int256 deltaBaseDebt;
            int256 deltaQuoteDebt;
            if (isBaseAdded) {
                // taker base not enough
                require(accountMarketInfo.takerBaseBalance >= response.base.toInt256(), "CH_TBNE");

                deltaBaseDebt = response.base.neg256();

                // move quote debt from taker to maker: takerQuoteDebt(-) * baseRemovedFromTaker(-) / totalTakerBase(+)
                // TODO: inspect overflow
                deltaQuoteDebt = accountMarketInfo.takerQuoteBalance.mul(deltaBaseDebt).div(
                    accountMarketInfo.takerBaseBalance
                );
            } else {
                // taker quote not enough
                require(accountMarketInfo.takerQuoteBalance >= response.quote.toInt256(), "CH_TQNE");

                deltaQuoteDebt = response.quote.neg256();

                // move base debt from taker to maker: takerBaseDebt(-) * quoteRemovedFromTaker(-) / totalTakerQuote(+)
                // TODO: inspect overflow
                deltaBaseDebt = accountMarketInfo.takerBaseBalance.mul(deltaQuoteDebt).div(
                    accountMarketInfo.takerQuoteBalance
                );
            }

            // update orderDebt to record the cost of this order
            IOrderBook(_orderBook).updateOrderDebt(response.orderId, deltaBaseDebt, deltaQuoteDebt);

            // update takerBalances as we're using takerBalances to provide liquidity
            IAccountBalance(_accountBalance).addTakerBalances(trader, params.baseToken, deltaBaseDebt, deltaQuoteDebt);
        }

        // fees always have to be collected to owedRealizedPnl, as long as there is a change in liquidity
        IAccountBalance(_accountBalance).addOwedRealizedPnl(trader, response.fee.toInt256());

        // after token balances are updated, we can check if there is enough free collateral
        _requireEnoughFreeCollateral(trader);

        emit LiquidityChanged(
            trader,
            params.baseToken,
            _quoteToken,
            params.lowerTick,
            params.upperTick,
            response.base.toInt256(),
            response.quote.toInt256(),
            response.liquidity.toInt128(),
            response.fee
        );

        return
            AddLiquidityResponse({
                base: response.base,
                quote: response.quote,
                fee: response.fee,
                liquidity: response.liquidity
            });
    }

    /// @inheritdoc IClearingHouse
    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        override
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (RemoveLiquidityResponse memory)
    {
        address trader = _msgSender();

        // must settle funding first
        IExchange(_exchange).settleFunding(trader, params.baseToken);

        IOrderBook.RemoveLiquidityResponse memory response =
            IOrderBook(_orderBook).removeLiquidity(
                IOrderBook.RemoveLiquidityParams({
                    maker: trader,
                    baseToken: params.baseToken,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );

        _settleBalanceAndRealizePnl(trader, params.baseToken, response);

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");

        emit LiquidityChanged(
            trader,
            params.baseToken,
            _quoteToken,
            params.lowerTick,
            params.upperTick,
            response.base.neg256(),
            response.quote.neg256(),
            params.liquidity.neg128(),
            response.fee
        );

        return RemoveLiquidityResponse({ quote: response.quote, base: response.base, fee: response.fee });
    }

    /// @inheritdoc IClearingHouse
    function openPosition(OpenPositionParams memory params)
        external
        override
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        address trader = _msgSender();
        IAccountBalance(_accountBalance).registerBaseToken(trader, params.baseToken);

        // must settle funding first
        Funding.Growth memory fundingGrowthGlobal = IExchange(_exchange).settleFunding(trader, params.baseToken);

        IExchange.SwapResponse memory response =
            _openPosition(
                InternalOpenPositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    isClose: false,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: false,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        _checkSlippage(
            InternalCheckSlippageParams({
                isBaseToQuote: params.isBaseToQuote,
                isExactInput: params.isExactInput,
                deltaAvailableQuote: response.deltaAvailableQuote,
                deltaAvailableBase: response.deltaAvailableBase,
                oppositeAmountBound: params.oppositeAmountBound
            })
        );

        emit ReferredPositionChanged(params.referralCode);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    /// @inheritdoc IClearingHouse
    function closePosition(ClosePositionParams calldata params)
        external
        override
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        address trader = _msgSender();

        // must settle funding first
        Funding.Growth memory fundingGrowthGlobal = IExchange(_exchange).settleFunding(trader, params.baseToken);

        IExchange.SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        // if exchangedPositionSize < 0, closing it is short, B2Q; else, closing it is long, Q2B
        bool isBaseToQuote = response.exchangedPositionSize < 0 ? true : false;
        uint256 oppositeAmountBound =
            response.isPartialClose
                ? params.oppositeAmountBound.mulRatio(IClearingHouseConfig(_clearingHouseConfig).getPartialCloseRatio())
                : params.oppositeAmountBound;
        _checkSlippage(
            InternalCheckSlippageParams({
                isBaseToQuote: isBaseToQuote,
                isExactInput: isBaseToQuote,
                deltaAvailableQuote: response.deltaAvailableQuote,
                deltaAvailableBase: response.deltaAvailableBase,
                oppositeAmountBound: oppositeAmountBound
            })
        );

        emit ReferredPositionChanged(params.referralCode);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    /// @inheritdoc IClearingHouse
    function liquidate(address trader, address baseToken) external override whenNotPaused nonReentrant {
        // per liquidation specs:
        //   https://www.notion.so/perp/Perpetual-Swap-Contract-s-Specs-Simulations-96e6255bf77e4c90914855603ff7ddd1
        //
        // liquidation trigger:
        //   accountMarginRatio < accountMaintenanceMarginRatio
        //   => accountValue / sum(abs(positionValue_market)) <
        //        sum(mmRatio * abs(positionValue_market)) / sum(abs(positionValue_market))
        //   => accountValue < sum(mmRatio * abs(positionValue_market))
        //   => accountValue < sum(abs(positionValue_market)) * mmRatio = totalMinimumMarginRequirement
        //

        // CH_NEO: not empty order
        require(!IAccountBalance(_accountBalance).hasOrder(trader), "CH_NEO");

        // CH_EAV: enough account value
        require(
            getAccountValue(trader) < IAccountBalance(_accountBalance).getMarginRequirementForLiquidation(trader),
            "CH_EAV"
        );

        // must settle funding first
        Funding.Growth memory fundingGrowthGlobal = IExchange(_exchange).settleFunding(trader, baseToken);
        IExchange.SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: baseToken,
                    sqrtPriceLimitX96: 0,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        // trader's pnl-- as liquidation penalty
        uint256 liquidationFee =
            response.exchangedPositionNotional.abs().mulRatio(
                IClearingHouseConfig(_clearingHouseConfig).getLiquidationPenaltyRatio()
            );

        IAccountBalance(_accountBalance).addOwedRealizedPnl(trader, liquidationFee.neg256());

        // increase liquidator's pnl liquidation reward
        address liquidator = _msgSender();
        IAccountBalance(_accountBalance).addOwedRealizedPnl(liquidator, liquidationFee.toInt256());

        emit PositionLiquidated(
            trader,
            baseToken,
            response.exchangedPositionNotional.abs(),
            response.deltaAvailableBase,
            liquidationFee,
            liquidator
        );
    }

    /// @inheritdoc IClearingHouse
    function cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external override whenNotPaused nonReentrant {
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    /// @inheritdoc IClearingHouse
    function cancelAllExcessOrders(address maker, address baseToken) external override whenNotPaused nonReentrant {
        bytes32[] memory orderIds = IOrderBook(_orderBook).getOpenOrderIds(maker, baseToken);
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        // For caller validation purposes it would be more efficient and more reliable to use
        // "msg.sender" instead of "_msgSender()" as contracts never call each other through GSN.
        // not orderbook
        require(msg.sender == _orderBook, "CH_NOB");

        IOrderBook.MintCallbackData memory callbackData = abi.decode(data, (IOrderBook.MintCallbackData));

        if (amount0Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token0();
            // CH_TF: Transfer failed
            require(IERC20Metadata(token).transfer(callbackData.pool, amount0Owed), "CH_TF");
        }
        if (amount1Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token1();
            // CH_TF: Transfer failed
            require(IERC20Metadata(token).transfer(callbackData.pool, amount1Owed), "CH_TF");
        }
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override onlyExchange {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_F0S: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        IExchange.SwapCallbackData memory callbackData = abi.decode(data, (IExchange.SwapCallbackData));
        IUniswapV3Pool uniswapV3Pool = IUniswapV3Pool(callbackData.pool);

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0
                ? (uniswapV3Pool.token0(), uint256(amount0Delta))
                : (uniswapV3Pool.token1(), uint256(amount1Delta));

        // swap
        // CH_TF: Transfer failed
        require(IERC20Metadata(token).transfer(address(callbackData.pool), amountToPay), "CH_TF");
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IClearingHouse
    function getQuoteToken() external view override returns (address) {
        return _quoteToken;
    }

    /// @inheritdoc IClearingHouse
    function getUniswapV3Factory() external view override returns (address) {
        return _uniswapV3Factory;
    }

    /// @inheritdoc IClearingHouse
    function getClearingHouseConfig() external view override returns (address) {
        return _clearingHouseConfig;
    }

    /// @inheritdoc IClearingHouse
    function getVault() external view override returns (address) {
        return _vault;
    }

    /// @inheritdoc IClearingHouse
    function getExchange() external view override returns (address) {
        return _exchange;
    }

    /// @inheritdoc IClearingHouse
    function getOrderBook() external view override returns (address) {
        return _orderBook;
    }

    /// @inheritdoc IClearingHouse
    function getAccountBalance() external view override returns (address) {
        return _accountBalance;
    }

    /// @inheritdoc IClearingHouse
    function getAccountValue(address trader) public view override returns (int256) {
        int256 fundingPayment = IExchange(_exchange).getAllPendingFundingPayment(trader);
        (int256 owedRealizedPnl, int256 unrealizedPnl) =
            IAccountBalance(_accountBalance).getOwedAndUnrealizedPnl(trader);
        // solhint-disable-next-line var-name-mixedcase
        int256 balanceX10_18 =
            SettlementTokenMath.parseSettlementToken(IVault(_vault).getBalance(trader), _settlementTokenDecimals);

        // accountValue = collateralValue + owedRealizedPnl - fundingPayment + unrealizedPnl
        return balanceX10_18.add(owedRealizedPnl.sub(fundingPayment)).add(unrealizedPnl);
    }

    //
    // INTERNAL NON-VIEW
    //

    function _cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] memory orderIds
    ) internal {
        // only cancel open orders if there are not enough free collateral with mmRatio
        // or account is able to being liquidated.
        // CH_NEXO: not excess orders
        require(
            (_getFreeCollateralByRatio(maker, IClearingHouseConfig(_clearingHouseConfig).getMmRatio()) < 0) ||
                getAccountValue(maker) < IAccountBalance(_accountBalance).getMarginRequirementForLiquidation(maker),
            "CH_NEXO"
        );

        // must settle funding first
        IExchange(_exchange).settleFunding(maker, baseToken);
        IOrderBook.RemoveLiquidityResponse memory response =
            IOrderBook(_orderBook).removeLiquidityByIds(maker, baseToken, orderIds);

        _settleBalanceAndRealizePnl(maker, baseToken, response);
    }

    function _settleBalanceAndRealizePnl(
        address maker,
        address baseToken,
        IOrderBook.RemoveLiquidityResponse memory response
    ) internal {
        int256 pnlToBeRealized;
        if (response.deltaTakerBase != 0) {
            pnlToBeRealized = IExchange(_exchange).getPnlToBeRealized(
                IExchange.RealizePnlParams({
                    trader: maker,
                    baseToken: baseToken,
                    deltaAvailableBase: response.deltaTakerBase,
                    deltaAvailableQuote: response.deltaTakerQuote
                })
            );
        }

        IAccountBalance(_accountBalance).settleBalanceAndDeregister(
            maker,
            baseToken,
            response.deltaTakerBase,
            response.deltaTakerQuote,
            pnlToBeRealized,
            response.fee.toInt256()
        );
    }

    /// @dev explainer diagram for the relationship between exchangedPositionNotional, fee and openNotional:
    ///      https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events
    function _openPosition(InternalOpenPositionParams memory params) internal returns (IExchange.SwapResponse memory) {
        IExchange.SwapResponse memory response =
            IExchange(_exchange).swap(
                IExchange.SwapParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    isClose: params.isClose,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    fundingGrowthGlobal: params.fundingGrowthGlobal
                })
            );

        if (!params.skipMarginRequirementCheck) {
            // it's not closing the position, check margin ratio
            _requireEnoughFreeCollateral(params.trader);
        }

        IAccountBalance(_accountBalance).deregisterBaseToken(params.trader, params.baseToken);

        return response;
    }

    function _closePosition(InternalClosePositionParams memory params)
        internal
        returns (IExchange.SwapResponse memory)
    {
        int256 positionSize = IAccountBalance(_accountBalance).getTakerPositionSize(params.trader, params.baseToken);

        // CH_PSZ: position size is zero
        require(positionSize != 0, "CH_PSZ");

        // old position is long. when closing, it's baseToQuote && exactInput (sell exact base)
        // old position is short. when closing, it's quoteToBase && exactOutput (buy exact base back)
        bool isLong = positionSize > 0;
        return
            _openPosition(
                InternalOpenPositionParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: isLong,
                    isExactInput: isLong,
                    isClose: true,
                    amount: positionSize.abs(),
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: true,
                    fundingGrowthGlobal: params.fundingGrowthGlobal
                })
            );
    }

    //
    // INTERNAL VIEW
    //

    /// @inheritdoc BaseRelayRecipient
    function _msgSender() internal view override(BaseRelayRecipient, OwnerPausable) returns (address payable) {
        return super._msgSender();
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, OwnerPausable) returns (bytes memory) {
        return super._msgData();
    }

    function _getFreeCollateralByRatio(address trader, uint24 ratio) internal view returns (int256) {
        return IVault(_vault).getFreeCollateralByRatio(trader, ratio);
    }

    function _requireEnoughFreeCollateral(address trader) internal view {
        // freeCollateral is calculated based on imRatio
        // CH_NEFCI: not enough account value by imRatio
        require(
            _getFreeCollateralByRatio(trader, IClearingHouseConfig(_clearingHouseConfig).getImRatio()) >= 0,
            "CH_NEFCI"
        );
    }

    function _checkSlippage(InternalCheckSlippageParams memory params) internal pure {
        // skip when params.oppositeAmountBound is zero
        if (params.oppositeAmountBound == 0) {
            return;
        }

        // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
        // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
        // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
        // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
        if (params.isBaseToQuote) {
            if (params.isExactInput) {
                // too little received when short
                require(params.deltaAvailableQuote >= params.oppositeAmountBound, "CH_TLRS");
            } else {
                // too much requested when short
                require(params.deltaAvailableBase <= params.oppositeAmountBound, "CH_TMRS");
            }
        } else {
            if (params.isExactInput) {
                // too little received when long
                require(params.deltaAvailableBase >= params.oppositeAmountBound, "CH_TLRL");
            } else {
                // too much requested when long
                require(params.deltaAvailableQuote <= params.oppositeAmountBound, "CH_TMRL");
            }
        }
    }
}
