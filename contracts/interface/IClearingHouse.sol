pragma solidity 0.7.6;
pragma abicoder v2;

interface IClearingHouse {

	struct Asset {
		uint available; 
		uint debt;
		uint fee;
	}

	struct OpenOrder {
		uint liquidity;
		uint24 tickLower;
		uint24 tickUpper;
        uint feeCumulativePerLiquidityBase;
		uint feeCumulativePerLiquidityQuote;
	}
	
	//naming: MakerOrder?
	struct MakerPosition {
		uint[] orderIds;
		// key: order id
		mapping(uint => OpenOrder) openOrderMap;
	}

    struct Account {
		uint margin;
		
		// key: vToken
		mapping(address => Asset) assetMap;
		// key: vToken, value: UniV3 pool
		mapping(address => address[]) tokenPoolsMap;
		
		// maker only
		address pools[];
		mapping(address => MakerPosition) makerPositionMap;
    }

	function deposit(uint _amount) external;	

	// trader's function
	function addMargin(uint _margin) external;
	function removeMargin(uint _margin) external;
	function openPosition(
			address _pool, 
			Side _side, 
			uint _quote, 
			uint _leverage, 
			uint baseLimit
		) external returns(uint base);
	function closePosition(address _pool, uint _quoteLimit) external returns(uint quote, uint base);
	function liquidate(address _pool, address _taker) external returns(uint base);

	// maker's function
	function mint(address _pool, uint _base, uint _quote) external;
	function burn(address _pool, uint _base, uint _quote) external;
	function addLiquidity(
			address _pool, 
			uint _base, 
			uint _minBase,
			uint _quote,
			uint _minQuote,
			uint _tickLower, 
			uint _tickUpper
		) external returns(uint liquidity, uint baseDelta, uint quoteDelta);
	function removeLiquidity(address _pool, uint _orderId, uint _liquidity) external returns(uint liquidity, uint baseDelta, uint quoteDelta, uint pnl);
	function cancelOpenOrder(address _pool, address _maker, uint _orderId, uint _liquidity) external;
	function collectFee(address _pool, uint _orderId) returns(uint feeBase, uint feeQuote) external;

	// view functions
	function getFreeCollateral(address _trader) external view returns(uint freeCollateral);
	function getMarginRatio(address _pool, address _trader) external view returns(uint marginRatio);
	function getPosition(address _pool, address _trader) external view returns(uint positionSize, uint pnl);
	function getPnl(address _pool, address _trader) external view returns(uint pnl);
	function getInitMarginRequirement(address _trader) external view returns(uint initMarginRequirement);

	function getOrders(address _pool, address _maker) external view returns(OpenOrder[]);
}
