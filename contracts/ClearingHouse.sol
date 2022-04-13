// SPDX-License-Identifier: GPL-3.0-or-later
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
import { Funding } from "./lib/Funding.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { IVault } from "./interface/IVault.sol";
import { IExchange } from "./interface/IExchange.sol";
import { IOrderBook } from "./interface/IOrderBook.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";
import { IBaseToken } from "./interface/IBaseToken.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { ClearingHouseStorageV1 } from "./storage/ClearingHouseStorage.sol";
import { BlockContext } from "./base/BlockContext.sol";
import { IClearingHouse } from "./interface/IClearingHouse.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";
import { OpenOrder } from "./lib/OpenOrder.sol";

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

    /// @param sqrtPriceLimitX96 tx will fill until it reaches this price but WON'T REVERT
    struct InternalOpenPositionParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        bool isClose;
        uint256 amount;
        uint160 sqrtPriceLimitX96;
        bool isLiquidation;
    }

    struct InternalClosePositionParams {
        address trader;
        address baseToken;
        uint160 sqrtPriceLimitX96;
        bool isLiquidation;
    }

    struct InternalCheckSlippageParams {
        bool isBaseToQuote;
        bool isExactInput;
        uint256 base;
        uint256 quote;
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
        address accountBalanceArg,
        address insuranceFundArg
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
        // CH_ENC: Exchange is not contract
        require(exchangeArg.isContract(), "CH_ENC");
        // CH_IFANC: InsuranceFund address is not contract
        require(insuranceFundArg.isContract(), "CH_IFANC");

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
        _insuranceFund = insuranceFundArg;

        _settlementTokenDecimals = IVault(_vault).decimals();
    }

    // solhint-disable-next-line func-order
    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        // CH_TFNC: TrustedForwarder is not contract
        require(trustedForwarderArg.isContract(), "CH_TFNC");
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
        // input requirement checks:
        //   baseToken: in Exchange.settleFunding()
        //   base & quote: in LiquidityAmounts.getLiquidityForAmounts() -> FullMath.mulDiv()
        //   lowerTick & upperTick: in UniswapV3Pool._modifyPosition()
        //   minBase, minQuote & deadline: here

        _checkMarketOpen(params.baseToken);

        // CH_DUTB: Disable useTakerBalance
        require(!params.useTakerBalance, "CH_DUTB");

        address trader = _msgSender();
        // register token if it's the first time
        IAccountBalance(_accountBalance).registerBaseToken(trader, params.baseToken);

        // must settle funding first
        Funding.Growth memory fundingGrowthGlobal = _settleFunding(trader, params.baseToken);

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

        // CH_PSCF: price slippage check fails
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSCF");

        // if !useTakerBalance, takerBalance won't change, only need to collects fee to oweRealizedPnl
        if (params.useTakerBalance) {
            bool isBaseAdded = response.base != 0;

            // can't add liquidity within range from take position
            require(isBaseAdded != (response.quote != 0), "CH_CALWRFTP");

            AccountMarket.Info memory accountMarketInfo =
                IAccountBalance(_accountBalance).getAccountInfo(trader, params.baseToken);

            // the signs of removedPositionSize and removedOpenNotional are always the opposite.
            int256 removedPositionSize;
            int256 removedOpenNotional;
            if (isBaseAdded) {
                // taker base not enough
                require(accountMarketInfo.takerPositionSize >= response.base.toInt256(), "CH_TBNE");

                removedPositionSize = response.base.neg256();

                // move quote debt from taker to maker:
                // takerOpenNotional(-) * removedPositionSize(-) / takerPositionSize(+)

                // overflow inspection:
                // Assume collateral is 2.406159692E28 and index price is 1e-18
                // takerOpenNotional ~= 10 * 2.406159692E28 = 2.406159692E29 --> x
                // takerPositionSize ~= takerOpenNotional/index price = x * 1e18 = 2.4061597E38
                // max of removedPositionSize = takerPositionSize = 2.4061597E38
                // (takerOpenNotional * removedPositionSize) < 2^255
                // 2.406159692E29 ^2 * 1e18 < 2^255
                removedOpenNotional = accountMarketInfo.takerOpenNotional.mul(removedPositionSize).div(
                    accountMarketInfo.takerPositionSize
                );
            } else {
                // taker quote not enough
                require(accountMarketInfo.takerOpenNotional >= response.quote.toInt256(), "CH_TQNE");

                removedOpenNotional = response.quote.neg256();

                // move base debt from taker to maker:
                // takerPositionSize(-) * removedOpenNotional(-) / takerOpenNotional(+)
                // overflow inspection: same as above
                removedPositionSize = accountMarketInfo.takerPositionSize.mul(removedOpenNotional).div(
                    accountMarketInfo.takerOpenNotional
                );
            }

            // update orderDebt to record the cost of this order
            IOrderBook(_orderBook).updateOrderDebt(
                OpenOrder.calcOrderKey(trader, params.baseToken, params.lowerTick, params.upperTick),
                removedPositionSize,
                removedOpenNotional
            );

            // update takerBalances as we're using takerBalances to provide liquidity
            (, int256 takerOpenNotional) =
                IAccountBalance(_accountBalance).modifyTakerBalance(
                    trader,
                    params.baseToken,
                    removedPositionSize,
                    removedOpenNotional
                );

            uint256 sqrtPrice = _getSqrtMarkTwapX96(params.baseToken, 0);
            _emitPositionChanged(
                trader,
                params.baseToken,
                removedPositionSize, // exchangedPositionSize
                removedOpenNotional, // exchangedPositionNotional
                0, // fee
                takerOpenNotional, // openNotional
                0, // realizedPnl
                sqrtPrice
            );
        }

        // fees always have to be collected to owedRealizedPnl, as long as there is a change in liquidity
        _modifyOwedRealizedPnl(trader, response.fee.toInt256());

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
        // input requirement checks:
        //   baseToken: in Exchange.settleFunding()
        //   lowerTick & upperTick: in UniswapV3Pool._modifyPosition()
        //   liquidity: in LiquidityMath.addDelta()
        //   minBase, minQuote & deadline: here

        // CH_MP: Market paused
        require(!IBaseToken(params.baseToken).isPaused(), "CH_MP");

        address trader = _msgSender();

        // must settle funding first
        _settleFunding(trader, params.baseToken);

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

        int256 realizedPnl = _settleBalanceAndRealizePnl(trader, params.baseToken, response);

        // CH_PSCF: price slippage check fails
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSCF");

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

        uint256 sqrtPrice = _getSqrtMarkTwapX96(params.baseToken, 0);
        int256 openNotional = _getTakerOpenNotional(trader, params.baseToken);
        _emitPositionChanged(
            trader,
            params.baseToken,
            response.takerBase, // exchangedPositionSize
            response.takerQuote, // exchangedPositionNotional
            0,
            openNotional,
            realizedPnl, // realizedPnl
            sqrtPrice
        );

        return RemoveLiquidityResponse({ quote: response.quote, base: response.base, fee: response.fee });
    }

    /// @inheritdoc IClearingHouse
    function settleAllFunding(address trader) external override {
        address[] memory baseTokens = IAccountBalance(_accountBalance).getBaseTokens(trader);
        uint256 baseTokenLength = baseTokens.length;
        for (uint256 i = 0; i < baseTokenLength; i++) {
            _settleFunding(trader, baseTokens[i]);
        }
    }

    /// @inheritdoc IClearingHouse
    function openPosition(OpenPositionParams memory params)
        external
        override
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 base, uint256 quote)
    {
        // input requirement checks:
        //   baseToken: in Exchange.settleFunding()
        //   isBaseToQuote & isExactInput: X
        //   amount: in UniswapV3Pool.swap()
        //   oppositeAmountBound: in _checkSlippage()
        //   deadline: here
        //   sqrtPriceLimitX96: X (this is not for slippage protection)
        //   referralCode: X

        _checkMarketOpen(params.baseToken);

        address trader = _msgSender();
        // register token if it's the first time
        IAccountBalance(_accountBalance).registerBaseToken(trader, params.baseToken);

        // must settle funding first
        _settleFunding(trader, params.baseToken);

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
                    isLiquidation: false
                })
            );

        _checkSlippage(
            InternalCheckSlippageParams({
                isBaseToQuote: params.isBaseToQuote,
                isExactInput: params.isExactInput,
                base: response.base,
                quote: response.quote,
                oppositeAmountBound: params.oppositeAmountBound
            })
        );

        if (params.referralCode != 0) {
            emit ReferredPositionChanged(params.referralCode);
        }
        return (response.base, response.quote);
    }

    /// @inheritdoc IClearingHouse
    function closePosition(ClosePositionParams calldata params)
        external
        override
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 base, uint256 quote)
    {
        // input requirement checks:
        //   baseToken: in Exchange.settleFunding()
        //   sqrtPriceLimitX96: X (this is not for slippage protection)
        //   oppositeAmountBound: in _checkSlippage()
        //   deadline: here
        //   referralCode: X

        _checkMarketOpen(params.baseToken);

        address trader = _msgSender();

        // must settle funding first
        _settleFunding(trader, params.baseToken);

        IExchange.SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    isLiquidation: false
                })
            );

        // if exchangedPositionSize < 0, closing it is short, B2Q; else, closing it is long, Q2B
        bool isBaseToQuote = response.exchangedPositionSize < 0 ? true : false;
        uint256 oppositeAmountBound = _getPartialOppositeAmount(params.oppositeAmountBound, response.isPartialClose);

        _checkSlippage(
            InternalCheckSlippageParams({
                isBaseToQuote: isBaseToQuote,
                isExactInput: isBaseToQuote,
                base: response.base,
                quote: response.quote,
                oppositeAmountBound: oppositeAmountBound
            })
        );

        if (params.referralCode != 0) {
            emit ReferredPositionChanged(params.referralCode);
        }
        return (response.base, response.quote);
    }

    /// @inheritdoc IClearingHouse
    function liquidate(
        address trader,
        address baseToken,
        uint256 oppositeAmountBound
    )
        external
        override
        whenNotPaused
        nonReentrant
        returns (
            uint256 base,
            uint256 quote,
            bool isPartialClose
        )
    {
        _checkMarketOpen(baseToken);

        // getTakerPosSize == getTotalPosSize now, because it will revert in _liquidate() if there's any maker order
        int256 positionSize = _getTakerPosition(trader, baseToken);

        // if positionSize > 0, it's long base, and closing it is thus short base, B2Q;
        // else, closing it is long base, Q2B
        bool isBaseToQuote = positionSize > 0;

        (base, quote, isPartialClose) = _liquidate(trader, baseToken);

        oppositeAmountBound = _getPartialOppositeAmount(oppositeAmountBound, isPartialClose);
        _checkSlippage(
            InternalCheckSlippageParams({
                isBaseToQuote: isBaseToQuote,
                isExactInput: isBaseToQuote,
                base: base,
                quote: quote,
                oppositeAmountBound: oppositeAmountBound
            })
        );

        return (base, quote, isPartialClose);
    }

    /// @inheritdoc IClearingHouse
    function liquidate(address trader, address baseToken) external override whenNotPaused nonReentrant {
        _checkMarketOpen(baseToken);
        _liquidate(trader, baseToken);
    }

    /// @inheritdoc IClearingHouse
    function cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external override whenNotPaused nonReentrant {
        // input requirement checks:
        //   maker: in _cancelExcessOrders()
        //   baseToken: in Exchange.settleFunding()
        //   orderIds: in OrderBook.removeLiquidityByIds()

        _checkMarketOpen(baseToken);
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    /// @inheritdoc IClearingHouse
    function cancelAllExcessOrders(address maker, address baseToken) external override whenNotPaused nonReentrant {
        // input requirement checks:
        //   maker: in _cancelExcessOrders()
        //   baseToken: in Exchange.settleFunding()
        //   orderIds: in OrderBook.removeLiquidityByIds()

        _checkMarketOpen(baseToken);
        _cancelExcessOrders(maker, baseToken, IOrderBook(_orderBook).getOpenOrderIds(maker, baseToken));
    }

    /// @inheritdoc IClearingHouse
    function quitMarket(address trader, address baseToken) external override returns (uint256 base, uint256 quote) {
        // CH_MNC: Market not closed
        require(IBaseToken(baseToken).isClosed(), "CH_MNC");
        // CH_HOICM: Has order in closed market
        require(IOrderBook(_orderBook).getOpenOrderIds(trader, baseToken).length == 0, "CH_HOICM");
        // CH_NP : no position
        int256 positionSize = _getTakerPosition(trader, baseToken);
        require(positionSize != 0, "CH_NP");

        _settleFunding(trader, baseToken);

        (int256 positionNotional, int256 openNotional, int256 realizedPnl, uint256 closedPrice) =
            IAccountBalance(_accountBalance).settlePositionInClosedMarket(trader, baseToken);

        emit PositionClosed(trader, baseToken, positionSize, positionNotional, openNotional, realizedPnl, closedPrice);

        return (positionSize.abs(), positionNotional.abs());
    }

    /// @inheritdoc IUniswapV3MintCallback
    /// @dev namings here follow Uniswap's convention
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        // input requirement checks:
        //   amount0Owed: here
        //   amount1Owed: here
        //   data: X

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
    /// @dev namings here follow Uniswap's convention
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override onlyExchange {
        // input requirement checks:
        //   amount0Delta: here
        //   amount1Delta: here
        //   data: X

        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_F0S: forbidden 0 swap
        require((amount0Delta > 0 && amount1Delta < 0) || (amount0Delta < 0 && amount1Delta > 0), "CH_F0S");

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
    function getInsuranceFund() external view override returns (address) {
        return _insuranceFund;
    }

    /// @inheritdoc IClearingHouse
    function getAccountValue(address trader) public view override returns (int256) {
        int256 fundingPayment = IExchange(_exchange).getAllPendingFundingPayment(trader);
        (int256 owedRealizedPnl, int256 unrealizedPnl, uint256 pendingFee) =
            IAccountBalance(_accountBalance).getPnlAndPendingFee(trader);
        // solhint-disable-next-line var-name-mixedcase
        int256 balanceX10_18 =
            SettlementTokenMath.parseSettlementToken(IVault(_vault).getBalance(trader), _settlementTokenDecimals);

        // accountValue = collateralValue + owedRealizedPnl - fundingPayment + unrealizedPnl + pendingMakerFee
        return balanceX10_18.add(owedRealizedPnl.sub(fundingPayment)).add(unrealizedPnl).add(pendingFee.toInt256());
    }

    //
    // INTERNAL NON-VIEW
    //

    function _liquidate(address trader, address baseToken)
        internal
        returns (
            uint256 base,
            uint256 quote,
            bool isPartialClose
        )
    {
        // liquidation trigger:
        //   accountMarginRatio < accountMaintenanceMarginRatio
        //   => accountValue / sum(abs(positionValue_market)) <
        //        sum(mmRatio * abs(positionValue_market)) / sum(abs(positionValue_market))
        //   => accountValue < sum(mmRatio * abs(positionValue_market))
        //   => accountValue < sum(abs(positionValue_market)) * mmRatio = totalMinimumMarginRequirement
        //

        // input requirement checks:
        //   trader: here
        //   baseToken: in Exchange.settleFunding()

        // CH_CLWTISO: cannot liquidate when there is still order
        require(!IAccountBalance(_accountBalance).hasOrder(trader), "CH_CLWTISO");

        // CH_EAV: enough account value
        require(_isLiquidatable(trader), "CH_EAV");

        // must settle funding first
        _settleFunding(trader, baseToken);
        IExchange.SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: baseToken,
                    sqrtPriceLimitX96: 0,
                    isLiquidation: true
                })
            );

        // trader's pnl-- as liquidation penalty
        uint256 liquidationFee =
            response.exchangedPositionNotional.abs().mulRatio(
                IClearingHouseConfig(_clearingHouseConfig).getLiquidationPenaltyRatio()
            );

        _modifyOwedRealizedPnl(trader, liquidationFee.neg256());

        // increase liquidator's pnl liquidation reward
        address liquidator = _msgSender();
        _modifyOwedRealizedPnl(liquidator, liquidationFee.toInt256());

        emit PositionLiquidated(
            trader,
            baseToken,
            response.exchangedPositionNotional.abs(),
            response.base,
            liquidationFee,
            liquidator
        );

        return (response.base, response.quote, response.isPartialClose);
    }

    /// @dev only cancel open orders if there are not enough free collateral with mmRatio
    /// or account is able to being liquidated.
    function _cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] memory orderIds
    ) internal {
        if (orderIds.length == 0) {
            return;
        }

        // CH_NEXO: not excess orders
        require(
            (_getFreeCollateralByRatio(maker, IClearingHouseConfig(_clearingHouseConfig).getMmRatio()) < 0) ||
                _isLiquidatable(maker),
            "CH_NEXO"
        );

        // must settle funding first
        _settleFunding(maker, baseToken);

        IOrderBook.RemoveLiquidityResponse memory removeLiquidityResponse;

        uint256 length = orderIds.length;
        for (uint256 i = 0; i < length; i++) {
            OpenOrder.Info memory order = IOrderBook(_orderBook).getOpenOrderById(orderIds[i]);

            IOrderBook.RemoveLiquidityResponse memory response =
                IOrderBook(_orderBook).removeLiquidity(
                    IOrderBook.RemoveLiquidityParams({
                        maker: maker,
                        baseToken: baseToken,
                        lowerTick: order.lowerTick,
                        upperTick: order.upperTick,
                        liquidity: order.liquidity
                    })
                );

            removeLiquidityResponse.base = removeLiquidityResponse.base.add(response.base);
            removeLiquidityResponse.quote = removeLiquidityResponse.quote.add(response.quote);
            removeLiquidityResponse.fee = removeLiquidityResponse.fee.add(response.fee);
            removeLiquidityResponse.takerBase = removeLiquidityResponse.takerBase.add(response.takerBase);
            removeLiquidityResponse.takerQuote = removeLiquidityResponse.takerQuote.add(response.takerQuote);

            emit LiquidityChanged(
                maker,
                baseToken,
                _quoteToken,
                order.lowerTick,
                order.upperTick,
                response.base.neg256(),
                response.quote.neg256(),
                order.liquidity.neg128(),
                response.fee
            );
        }

        int256 realizedPnl = _settleBalanceAndRealizePnl(maker, baseToken, removeLiquidityResponse);

        uint256 sqrtPrice = _getSqrtMarkTwapX96(baseToken, 0);
        int256 openNotional = _getTakerOpenNotional(maker, baseToken);
        _emitPositionChanged(
            maker,
            baseToken,
            removeLiquidityResponse.takerBase, // exchangedPositionSize
            removeLiquidityResponse.takerQuote, // exchangedPositionNotional
            0,
            openNotional,
            realizedPnl, // realizedPnl
            sqrtPrice
        );
    }

    /// @dev Calculate how much profit/loss we should settled,
    /// only used when removing liquidity. The profit/loss is calculated by using
    /// the removed base/quote amount and existing taker's base/quote amount.
    function _settleBalanceAndRealizePnl(
        address maker,
        address baseToken,
        IOrderBook.RemoveLiquidityResponse memory response
    ) internal returns (int256) {
        int256 pnlToBeRealized;
        if (response.takerBase != 0) {
            pnlToBeRealized = IExchange(_exchange).getPnlToBeRealized(
                IExchange.RealizePnlParams({
                    trader: maker,
                    baseToken: baseToken,
                    base: response.takerBase,
                    quote: response.takerQuote
                })
            );
        }

        // pnlToBeRealized is realized here
        IAccountBalance(_accountBalance).settleBalanceAndDeregister(
            maker,
            baseToken,
            response.takerBase,
            response.takerQuote,
            pnlToBeRealized,
            response.fee.toInt256()
        );

        return pnlToBeRealized;
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
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96
                })
            );

        _modifyOwedRealizedPnl(_insuranceFund, response.insuranceFundFee.toInt256());

        IAccountBalance(_accountBalance).modifyTakerBalance(
            params.trader,
            params.baseToken,
            response.exchangedPositionSize,
            response.exchangedPositionNotional.sub(response.fee.toInt256())
        );

        if (response.pnlToBeRealized != 0) {
            IAccountBalance(_accountBalance).settleQuoteToOwedRealizedPnl(
                params.trader,
                params.baseToken,
                response.pnlToBeRealized
            );

            // if realized pnl is not zero, that means trader is reducing or closing position
            // trader cannot reduce/close position if bad debt happen
            // unless it's a liquidation from backstop liquidity provider
            // CH_BD: trader has bad debt after reducing/closing position
            require(
                (params.isLiquidation &&
                    IClearingHouseConfig(_clearingHouseConfig).isBackstopLiquidityProvider(_msgSender())) ||
                    getAccountValue(params.trader) >= 0,
                "CH_BD"
            );
        }

        // if not closing a position, check margin ratio after swap
        if (!params.isClose) {
            _requireEnoughFreeCollateral(params.trader);
        }

        int256 openNotional = _getTakerOpenNotional(params.trader, params.baseToken);
        _emitPositionChanged(
            params.trader,
            params.baseToken,
            response.exchangedPositionSize,
            response.exchangedPositionNotional,
            response.fee,
            openNotional,
            response.pnlToBeRealized,
            response.sqrtPriceAfterX96
        );

        IAccountBalance(_accountBalance).deregisterBaseToken(params.trader, params.baseToken);

        return response;
    }

    /// @dev The actual close position logic.
    function _closePosition(InternalClosePositionParams memory params)
        internal
        returns (IExchange.SwapResponse memory)
    {
        int256 positionSize = _getTakerPosition(params.trader, params.baseToken);

        // CH_PSZ: position size is zero
        require(positionSize != 0, "CH_PSZ");

        // old position is long. when closing, it's baseToQuote && exactInput (sell exact base)
        // old position is short. when closing, it's quoteToBase && exactOutput (buy exact base back)
        bool isBaseToQuote = positionSize > 0;
        return
            _openPosition(
                InternalOpenPositionParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: isBaseToQuote,
                    isExactInput: isBaseToQuote,
                    isClose: true,
                    amount: positionSize.abs(),
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    isLiquidation: params.isLiquidation
                })
            );
    }

    /// @dev Settle trader's funding payment to his/her realized pnl.
    function _settleFunding(address trader, address baseToken)
        internal
        returns (Funding.Growth memory fundingGrowthGlobal)
    {
        int256 fundingPayment;
        (fundingPayment, fundingGrowthGlobal) = IExchange(_exchange).settleFunding(trader, baseToken);

        if (fundingPayment != 0) {
            _modifyOwedRealizedPnl(trader, fundingPayment.neg256());
            emit FundingPaymentSettled(trader, baseToken, fundingPayment);
        }

        IAccountBalance(_accountBalance).updateTwPremiumGrowthGlobal(
            trader,
            baseToken,
            fundingGrowthGlobal.twPremiumX96
        );
        return fundingGrowthGlobal;
    }

    function _modifyOwedRealizedPnl(address trader, int256 amount) internal {
        IAccountBalance(_accountBalance).modifyOwedRealizedPnl(trader, amount);
    }

    function _emitPositionChanged(
        address trader,
        address baseToken,
        int256 exchangedPositionSize,
        int256 exchangedPositionNotional,
        uint256 fee,
        int256 openNotional,
        int256 realizedPnl,
        uint256 sqrtPriceAfterX96
    ) internal {
        emit PositionChanged(
            trader,
            baseToken,
            exchangedPositionSize,
            exchangedPositionNotional,
            fee,
            openNotional,
            realizedPnl,
            sqrtPriceAfterX96
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

    function _getTakerOpenNotional(address trader, address baseToken) internal view returns (int256) {
        return IAccountBalance(_accountBalance).getTakerOpenNotional(trader, baseToken);
    }

    function _getTakerPosition(address trader, address baseToken) internal view returns (int256) {
        return IAccountBalance(_accountBalance).getTakerPositionSize(trader, baseToken);
    }

    function _getFreeCollateralByRatio(address trader, uint24 ratio) internal view returns (int256) {
        return IVault(_vault).getFreeCollateralByRatio(trader, ratio);
    }

    function _getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) internal view returns (uint160) {
        return IExchange(_exchange).getSqrtMarkTwapX96(baseToken, twapInterval);
    }

    function _isLiquidatable(address trader) internal view returns (bool) {
        return getAccountValue(trader) < IAccountBalance(_accountBalance).getMarginRequirementForLiquidation(trader);
    }

    function _requireEnoughFreeCollateral(address trader) internal view {
        // CH_NEFCI: not enough free collateral by imRatio
        require(
            _getFreeCollateralByRatio(trader, IClearingHouseConfig(_clearingHouseConfig).getImRatio()) >= 0,
            "CH_NEFCI"
        );
    }

    function _getPartialOppositeAmount(uint256 oppositeAmountBound, bool isPartialClose)
        internal
        view
        returns (uint256)
    {
        return
            isPartialClose
                ? oppositeAmountBound.mulRatio(IClearingHouseConfig(_clearingHouseConfig).getPartialCloseRatio())
                : oppositeAmountBound;
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
                require(params.quote >= params.oppositeAmountBound, "CH_TLRS");
            } else {
                // too much requested when short
                require(params.base <= params.oppositeAmountBound, "CH_TMRS");
            }
        } else {
            if (params.isExactInput) {
                // too little received when long
                require(params.base >= params.oppositeAmountBound, "CH_TLRL");
            } else {
                // too much requested when long
                require(params.quote <= params.oppositeAmountBound, "CH_TMRL");
            }
        }
    }

    function _checkMarketOpen(address baseToken) internal view {
        // CH_BC: Market not opened
        require(IBaseToken(baseToken).isOpen(), "CH_MNO");
    }
}
